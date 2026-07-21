import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type AppDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { agents, issues, projects } from "../lib/db/schema";
import {
  assertProfessionalCommit,
  GitWorkspaceManager,
  inspectOutgoingCommits,
  isProhibitedAgentMarkdown,
} from "../lib/git-workspace";
import { IssueLifecycleService } from "../lib/issue-lifecycle";

const exec = promisify(execFile);
const identity = { name: "Nexotao Maintainer", email: "maintainer@nexotao.test" };

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-workspace-test-"));
  const repositoryPath = path.join(dir, "repository");
  const managedRoot = path.join(dir, "managed-worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, "init", "-b", "main");
  await git(repositoryPath, "config", "user.name", identity.name);
  await git(repositoryPath, "config", "user.email", identity.email);
  await writeFile(path.join(repositoryPath, "shared.txt"), "base\n");
  await git(repositoryPath, "add", "shared.txt");
  await git(repositoryPath, "commit", "-m", "chore(repo): initialize fixture");

  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => {
    db.insert(projects).values({ id: "project", name: "Project", path: repositoryPath, mode: "multi", agentSpecs: [], createdAt: 1 }).run();
    db.insert(agents).values(["one", "two", "worker", "lead-bad", "lead-good", "clean"].map((id, index) => ({
      id: `agent-${id}`, projectId: "project", name: id, role: id.startsWith("lead") ? "lead" as const : "worker" as const,
      scope: id, createdAt: index + 2, updatedAt: index + 2,
    }))).run();
    db.insert(issues).values(["one", "two", "worker", "lead-bad", "lead-good", "clean"].map((id, index) => ({
      id: `issue-${id}`, projectId: "project", identifier: `NEXA-${index + 1}`, title: id, status: "todo",
      assigneeAgentId: `agent-${id}`, createdAt: index + 20, updatedAt: index + 20,
    }))).run();
  });
  const repositories = new ControlPlaneRepositories(database);
  return { dir, repositoryPath, managedRoot, database, repositories, manager: new GitWorkspaceManager(repositories, managedRoot) };
}

async function activate(f: Fixture, id: string) {
  const now = Date.now();
  const heartbeat = await f.repositories.createHeartbeat({
    agentId: `agent-${id}`, issueId: `issue-${id}`, wakeupId: null, source: "assignment", status: "running",
    sessionBefore: null, sessionAfter: null, usage: {}, error: null, workspacePath: null, workspaceBranch: null,
    queuedAt: now, startedAt: now, updatedAt: now, finishedAt: null,
  });
  await new IssueLifecycleService(f.database).checkout(`issue-${id}`, `agent-${id}`, heartbeat.id, now);
  return heartbeat.id;
}

async function cleanup(f: Fixture) {
  await f.database.close();
  await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

test("parallel writable runs receive distinct persisted worktrees and cannot validate each other's assignment", async () => {
  const f = await fixture();
  try {
    const [runOne, runTwo] = await Promise.all([activate(f, "one"), activate(f, "two")]);
    const [one, two] = await Promise.all([
      f.manager.provision({ projectId: "project", issueId: "issue-one", identifier: "NEXA-1", runId: runOne, repositoryPath: f.repositoryPath }),
      f.manager.provision({ projectId: "project", issueId: "issue-two", identifier: "NEXA-2", runId: runTwo, repositoryPath: f.repositoryPath }),
    ]);

    assert.notEqual(one.workspacePath, two.workspacePath);
    assert.notEqual(one.branch, two.branch);
    assert.equal(f.repositories.issues.get("issue-one")?.workspacePath, one.workspacePath);
    assert.equal(f.repositories.getHeartbeat(runTwo)?.workspaceBranch, two.branch);

    await writeFile(path.join(one.workspacePath, "only-one.txt"), "worker one\n");
    await assert.rejects(access(path.join(two.workspacePath, "only-one.txt")));
    await f.manager.validate("issue-one", runOne);
    await assert.rejects(f.manager.validate("issue-one", runTwo), /No persisted workspace assignment/);

    await f.repositories.issues.update("issue-two", { workspacePath: one.workspacePath });
    await assert.rejects(f.manager.mutationGuard("issue-two", runTwo)({ name: "write_file", input: { path: "unsafe.txt" } }), /no longer owns/);
    await assert.rejects(f.manager.mutationGuard("issue-one", runOne)({ name: "bash", input: { command: "git push origin main" } }), /verified integration flow/);
  } finally { await cleanup(f); }
});

test("lead integration rejects failed verification and promotes only a verified conflict-free commit", async () => {
  const f = await fixture();
  try {
    const workerRun = await activate(f, "worker");
    const worker = await f.manager.provision({ projectId: "project", issueId: "issue-worker", identifier: "NEXA-3", runId: workerRun, repositoryPath: f.repositoryPath });
    await writeFile(path.join(worker.workspacePath, "feature.txt"), "isolated change\n");
    const child = await f.manager.finalizeCommit("issue-worker", workerRun, "NEXA-3");
    assert.equal(f.repositories.issues.get("issue-worker")?.verificationStatus, "committed");

    const badRun = await activate(f, "lead-bad");
    await f.manager.provision({ projectId: "project", issueId: "issue-lead-bad", identifier: "NEXA-4", runId: badRun, repositoryPath: f.repositoryPath });
    await f.manager.cherryPickChildren("issue-lead-bad", badRun, [{
      identifier: "NEXA-3", workspaceCommit: child.commit, workspaceBaseCommit: worker.baseCommit, verificationStatus: "committed",
    }]);
    await assert.rejects(f.manager.verifyAndPromote("issue-lead-bad", badRun, "NEXA-4", ["node -e 'process.exit(7)'"]));
    assert.equal(f.repositories.getWorkspace(badRun)?.state, "rejected");
    await assert.rejects(access(path.join(f.repositoryPath, "feature.txt")), "failed verification must not change the target branch");

    const goodRun = await activate(f, "lead-good");
    await f.manager.provision({ projectId: "project", issueId: "issue-lead-good", identifier: "NEXA-5", runId: goodRun, repositoryPath: f.repositoryPath });
    await f.manager.cherryPickChildren("issue-lead-good", goodRun, [{
      identifier: "NEXA-3", workspaceCommit: child.commit, workspaceBaseCommit: worker.baseCommit, verificationStatus: "committed",
    }]);
    const promoted = await f.manager.verifyAndPromote("issue-lead-good", goodRun, "NEXA-5", ["git diff --check HEAD^ HEAD"]);
    assert.equal(await readFile(path.join(f.repositoryPath, "feature.txt"), "utf8"), "isolated change\n");
    assert.equal(f.repositories.getWorkspace(goodRun)?.state, "verified");
    assert.equal(await git(f.repositoryPath, "rev-parse", "HEAD"), promoted.commit);
  } finally { await cleanup(f); }
});

test("history policy audits every outgoing commit and orphan recovery never deletes user work", async () => {
  const f = await fixture();
  try {
    assert.equal(isProhibitedAgentMarkdown(".agents/runtime.md"), true);
    assert.equal(isProhibitedAgentMarkdown("docs/user-guide.md"), false);
    assert.doesNotThrow(() => assertProfessionalCommit("fix(runtime): preserve isolated writes"));
    assert.throws(() => assertProfessionalCommit("Fix isolated writes"), /Conventional Commits/);
    assert.throws(() => assertProfessionalCommit("fix(runtime): preserve writes\n\nGenerated-by: Codex"), /attribution/);

    const base = await git(f.repositoryPath, "rev-parse", "HEAD");
    await writeFile(path.join(f.repositoryPath, "AGENTS.md"), "local instructions\n");
    await git(f.repositoryPath, "add", "AGENTS.md");
    await git(f.repositoryPath, "commit", "-m", "chore(repo): add local instructions");
    await rm(path.join(f.repositoryPath, "AGENTS.md"));
    await git(f.repositoryPath, "add", "-u");
    await git(f.repositoryPath, "commit", "-m", "chore(repo): remove local instructions");
    const head = await git(f.repositoryPath, "rev-parse", "HEAD");
    assert.equal(await git(f.repositoryPath, "diff", "--name-only", `${base}..${head}`), "", "the prohibited path is absent from the net diff");
    await assert.rejects(inspectOutgoingCommits(f.repositoryPath, base, head, identity), /local-only/);

    await git(f.repositoryPath, "switch", "-c", "identity-check", base);
    await writeFile(path.join(f.repositoryPath, "identity.txt"), "bad identity\n");
    await git(f.repositoryPath, "add", "identity.txt");
    await git(f.repositoryPath, "-c", "user.name=Unapproved", "-c", "user.email=unapproved@example.test", "commit", "-m", "test(policy): reject invalid identity");
    await assert.rejects(inspectOutgoingCommits(f.repositoryPath, base, await git(f.repositoryPath, "rev-parse", "HEAD"), identity), /approved identity/);

    await git(f.repositoryPath, "switch", "main");
    const dirtyRun = await activate(f, "one");
    const dirty = await f.manager.provision({ projectId: "project", issueId: "issue-one", identifier: "NEXA-1", runId: dirtyRun, repositoryPath: f.repositoryPath });
    await writeFile(path.join(dirty.workspacePath, "unsaved.txt"), "preserve me\n");
    await f.repositories.completeHeartbeat(dirtyRun, "failed", { error: "crash" }, { error: "crash" });
    const detected = await f.manager.detectOrphans("project");
    assert.equal(detected[0]?.dirty, true);
    await assert.rejects(f.manager.cleanupOrphan(dirtyRun), /contains user work/);
    assert.equal(await readFile(path.join(dirty.workspacePath, "unsaved.txt"), "utf8"), "preserve me\n");
    const recovered = await f.manager.recoverOrphan(dirtyRun);
    assert.equal(recovered.available, true);
    assert.equal(recovered.dirty, true);

    const cleanRun = await activate(f, "clean");
    const clean = await f.manager.provision({ projectId: "project", issueId: "issue-clean", identifier: "NEXA-6", runId: cleanRun, repositoryPath: f.repositoryPath });
    await f.repositories.completeHeartbeat(cleanRun, "failed", { error: "crash" }, { error: "crash" });
    await f.manager.detectOrphans("project");
    const removed = await f.manager.cleanupOrphan(cleanRun);
    assert.equal(removed.removed, true);
    await assert.rejects(access(clean.workspacePath));
    assert.ok(await git(f.repositoryPath, "show-ref", "--verify", `refs/heads/${clean.branch}`), "cleanup retains the recovery branch");
  } finally { await cleanup(f); }
});
