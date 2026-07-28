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
  failureMessage,
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
    db.insert(agents).values(["one", "two", "worker", "lead-bad", "lead-good", "clean", "ship", "moved", "idle", "held", "rewound", "clash"].map((id, index) => ({
      id: `agent-${id}`, projectId: "project", name: id, role: id.startsWith("lead") ? "lead" as const : "worker" as const,
      scope: id, createdAt: index + 2, updatedAt: index + 2,
    }))).run();
    db.insert(issues).values(["one", "two", "worker", "lead-bad", "lead-good", "clean", "ship", "moved", "idle", "held", "rewound", "clash"].map((id, index) => ({
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

test("pulling an upstream repository is exempt from the outgoing-commit identity policy", async () => {
  const f = await fixture();
  try {
    const base = await git(f.repositoryPath, "rev-parse", "HEAD");

    // Stand up a separate upstream repository with third-party history, authored
    // by an identity that is not the repository-approved one.
    const upstreamPath = path.join(f.dir, "upstream");
    await mkdir(upstreamPath, { recursive: true });
    await git(upstreamPath, "init", "-b", "main");
    await git(upstreamPath, "config", "user.name", "Upstream Maintainer");
    await git(upstreamPath, "config", "user.email", "maintainer@upstream.test");
    await writeFile(path.join(upstreamPath, "trading.py"), "print('hello')\n");
    await git(upstreamPath, "add", "trading.py");
    await git(upstreamPath, "commit", "-m", "docs: streamline onboarding");
    const upstreamHead = await git(upstreamPath, "rev-parse", "HEAD");

    // Pull it into the project the way the agent flow does: add remote, fetch, reset.
    await git(f.repositoryPath, "remote", "add", "upstream", upstreamPath);
    await git(f.repositoryPath, "fetch", "upstream");
    await git(f.repositoryPath, "reset", "--hard", "upstream/main");
    assert.equal(await git(f.repositoryPath, "rev-parse", "HEAD"), upstreamHead);

    // Imported foreign history must not trip the identity/attribution guard — this
    // is the exact "pull repo" failure the policy previously rejected.
    const imported = await inspectOutgoingCommits(f.repositoryPath, base, upstreamHead, identity);
    assert.equal(imported.commits, 0, "pulled upstream commits are exempt from the policy");

    // A commit authored locally on top of the pull is still fully policed.
    await writeFile(path.join(f.repositoryPath, "local.txt"), "agent work\n");
    await git(f.repositoryPath, "add", "local.txt");
    await git(f.repositoryPath, "-c", "user.name=Unapproved", "-c", "user.email=unapproved@example.test", "commit", "-m", "chore(repo): add local file");
    await assert.rejects(
      inspectOutgoingCommits(f.repositoryPath, base, await git(f.repositoryPath, "rev-parse", "HEAD"), identity),
      /approved identity/,
      "commits authored locally above imported history are still policed",
    );
  } finally { await cleanup(f); }
});

test("a failed command reports the cause, not git's progress narration", () => {
  const stderr = "Preparing worktree (new branch 'nexotao/nx-22/a9f67ea3')\nfatal: a branch named 'nexotao/nx-22/a9f67ea3' already exists";
  const message = failureMessage(stderr, "", "git exited with 128");
  assert.match(message.split("\n")[0], /^fatal: a branch named/, "the fatal line leads so a one-line UI shows the cause");
  assert.match(message, /Preparing worktree/, "the narration is kept as trailing detail");
  assert.equal(failureMessage("", "", "git exited with 128"), "git exited with 128", "falls back when the command said nothing");
  assert.equal(failureMessage("just noise", "", "fallback"), "just noise", "output without a fatal line is passed through");
});

test("a failed workspace record rolls back the worktree so the same run can retry", async () => {
  const f = await fixture();
  try {
    const run = await activate(f, "one");
    const input = { projectId: "project", issueId: "issue-one", identifier: "NEXA-1", runId: run, repositoryPath: f.repositoryPath };
    // Persistence can fail transiently (see the atomic-write retry work); the
    // worktree must not outlive the failed record, or the branch — named after
    // the run id — permanently blocks every retry of this run.
    const assign = f.repositories.assignWorkspace.bind(f.repositories);
    f.repositories.assignWorkspace = async () => { throw new Error("database is locked"); };
    await assert.rejects(f.manager.provision(input), /database is locked/, "the original cause is reported");

    assert.equal(await git(f.repositoryPath, "branch", "--list", "nexotao/*"), "", "the orphaned branch is deleted");
    assert.equal((await git(f.repositoryPath, "worktree", "list")).split("\n").length, 1, "only the main worktree remains");

    f.repositories.assignWorkspace = assign;
    const assignment = await f.manager.provision(input);
    assert.equal(assignment.runId, run, "the same run id provisions cleanly on retry");
    assert.equal(await git(assignment.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"), assignment.branch);
  } finally { await cleanup(f); }
});

test("provisioning a fresh non-git project directory initialises a repository with its files", async () => {
  const f = await fixture();
  try {
    const fresh = path.join(f.dir, "fresh-project");
    await mkdir(fresh, { recursive: true });
    await writeFile(path.join(fresh, "README.md"), "hello\n");
    const run = await activate(f, "two");
    const assignment = await f.manager.provision({ projectId: "project", issueId: "issue-two", identifier: "NEXA-2", runId: run, repositoryPath: fresh });
    // the directory is now a git repo, and the run's worktree is a faithful copy
    assert.ok(await git(fresh, "rev-parse", "HEAD"), "fresh directory becomes a git repository");
    assert.equal(await git(assignment.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"), assignment.branch);
    assert.equal(await readFile(path.join(assignment.workspacePath, "README.md"), "utf8"), "hello\n");
  } finally { await cleanup(f); }
});

/* A submodule whose *contents* changed is reported by `git diff` as a changed
 * path, but `git add --all` stages nothing for it — the superproject's gitlink
 * still points at the same commit. Committing then failed with "no changes added
 * to commit", so every run in a repository with a dirty submodule was reported
 * as failed no matter what the agent had done. */
test("a dirty submodule does not fail the run's commit", async () => {
  const f = await fixture();
  try {
    const inner = path.join(f.dir, "inner");
    await mkdir(inner, { recursive: true });
    await git(inner, "init", "-b", "main");
    await git(inner, "config", "user.name", identity.name);
    await git(inner, "config", "user.email", identity.email);
    await writeFile(path.join(inner, "lib.txt"), "one\n");
    await git(inner, "add", "lib.txt");
    await git(inner, "commit", "-m", "chore(inner): initialize");

    await git(f.repositoryPath, "-c", "protocol.file.allow=always", "submodule", "add", inner, "vendor");
    await git(f.repositoryPath, "commit", "-m", "chore(repo): vendor the inner repository");

    const run = await activate(f, "one");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-one", identifier: "NEXA-1", runId: run, repositoryPath: f.repositoryPath,
    });
    await git(assignment.workspacePath, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    // Exactly the state the user hit: modified content plus an untracked file,
    // inside the submodule and nowhere else.
    await writeFile(path.join(assignment.workspacePath, "vendor", "lib.txt"), "one\ntwo\n");
    await writeFile(path.join(assignment.workspacePath, "vendor", "scratch.txt"), "untracked\n");

    const finalized = await f.manager.finalizeCommit("issue-one", run, "NEXA-1");
    assert.equal(finalized.commit, assignment.baseCommit, "nothing was committable, so HEAD did not move");
    assert.equal(f.repositories.issues.get("issue-one")?.verificationStatus, "committed");
  } finally { await cleanup(f); }
});

test("a real file change still commits when a submodule is also dirty", async () => {
  const f = await fixture();
  try {
    const inner = path.join(f.dir, "inner2");
    await mkdir(inner, { recursive: true });
    await git(inner, "init", "-b", "main");
    await git(inner, "config", "user.name", identity.name);
    await git(inner, "config", "user.email", identity.email);
    await writeFile(path.join(inner, "lib.txt"), "one\n");
    await git(inner, "add", "lib.txt");
    await git(inner, "commit", "-m", "chore(inner): initialize");
    await git(f.repositoryPath, "-c", "protocol.file.allow=always", "submodule", "add", inner, "vendor");
    await git(f.repositoryPath, "commit", "-m", "chore(repo): vendor the inner repository");

    const run = await activate(f, "two");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-two", identifier: "NEXA-2", runId: run, repositoryPath: f.repositoryPath,
    });
    await git(assignment.workspacePath, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    await writeFile(path.join(assignment.workspacePath, "vendor", "lib.txt"), "one\ntwo\n");
    await writeFile(path.join(assignment.workspacePath, "feature.txt"), "the agent's actual work\n");

    const finalized = await f.manager.finalizeCommit("issue-two", run, "NEXA-2");
    assert.notEqual(finalized.commit, assignment.baseCommit, "the agent's work is committed");
    assert.equal(await git(assignment.workspacePath, "show", "--name-only", "--format=", "HEAD"), "feature.txt");
  } finally { await cleanup(f); }
});

// The isolation is only half the contract. Committing the agent's work to
// `nexotao/nx-N/<runId>` and stopping there leaves the folder the user is
// looking at untouched while the task reports done — the work exists only on a
// branch no screen in the app mentions. Integration is what closes that gap,
// and it must fast-forward or refuse, never rewrite.
test("a finished run lands in the user's own branch", async () => {
  const f = await fixture();
  try {
    const run = await activate(f, "ship");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-ship", identifier: "NEXA-7", runId: run, repositoryPath: f.repositoryPath,
    });
    await writeFile(path.join(assignment.workspacePath, "README.md"), "# Shipped\n");
    await f.manager.finalizeCommit("issue-ship", run, "NEXA-7");

    const outcome = await f.manager.integrate(run);
    assert.equal(outcome.integrated, true);
    assert.equal(outcome.reason, undefined);
    assert.equal(await readFile(path.join(f.repositoryPath, "README.md"), "utf8"), "# Shipped\n");
    assert.equal(await git(f.repositoryPath, "rev-parse", "HEAD"), outcome.commit);
    assert.equal(f.repositories.getWorkspace(run)?.state, "verified");
  } finally { await cleanup(f); }
});

test("work still lands when the branch moved forward under it", async () => {
  const f = await fixture();
  try {
    const run = await activate(f, "moved");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-moved", identifier: "NEXA-8", runId: run, repositoryPath: f.repositoryPath,
    });
    await writeFile(path.join(assignment.workspacePath, "agent.txt"), "agent work\n");
    await f.manager.finalizeCommit("issue-moved", run, "NEXA-8");

    // Something lands on the branch while the agent is working — the user
    // committing, or (far more often) a teammate's sub-task finishing first.
    // Every teammate branches from the same base, so all but the first would be
    // stranded if this were refused: the user delegates three files and finds one.
    await writeFile(path.join(f.repositoryPath, "mine.txt"), "my work\n");
    await git(f.repositoryPath, "add", "mine.txt");
    await git(f.repositoryPath, "commit", "-m", "feat(app): my own work");
    const theirs = await git(f.repositoryPath, "rev-parse", "HEAD");

    const outcome = await f.manager.integrate(run);
    assert.equal(outcome.integrated, true);
    assert.equal(outcome.reason, undefined);
    // Both survive: the replay adds to the branch rather than replacing it.
    assert.equal(await readFile(path.join(f.repositoryPath, "agent.txt"), "utf8"), "agent work\n");
    assert.equal(await readFile(path.join(f.repositoryPath, "mine.txt"), "utf8"), "my work\n");
    assert.equal(
      await git(f.repositoryPath, "merge-base", "--is-ancestor", theirs, "HEAD").then(() => true).catch(() => false),
      true, "the commit that was already there is still in the history",
    );
  } finally { await cleanup(f); }
});

test("integration refuses when the branch diverged rather than advanced", async () => {
  const f = await fixture();
  try {
    // The user rewound their branch mid-run. Replaying onto that would quietly
    // discard whatever they dropped, so this is the case that must still refuse.
    await writeFile(path.join(f.repositoryPath, "history.txt"), "keeping\n");
    await git(f.repositoryPath, "add", "history.txt");
    await git(f.repositoryPath, "commit", "-m", "feat(app): a commit to rewind past");

    const run = await activate(f, "rewound");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-rewound", identifier: "NEXA-11", runId: run, repositoryPath: f.repositoryPath,
    });
    await writeFile(path.join(assignment.workspacePath, "agent.txt"), "agent work\n");
    await f.manager.finalizeCommit("issue-rewound", run, "NEXA-11");

    await git(f.repositoryPath, "reset", "--hard", "HEAD~1");
    const userHead = await git(f.repositoryPath, "rev-parse", "HEAD");

    const outcome = await f.manager.integrate(run);
    assert.equal(outcome.integrated, false);
    assert.match(outcome.reason ?? "", /diverged/);
    assert.match(outcome.reason ?? "", new RegExp(assignment.branch), "the refusal says where the work is");
    assert.equal(await git(f.repositoryPath, "rev-parse", "HEAD"), userHead, "the user's branch is left exactly where they put it");
    await assert.rejects(access(path.join(f.repositoryPath, "agent.txt")));
    // The work is not lost — it is on its branch, ready to merge by hand.
    assert.equal(await git(f.repositoryPath, "show", `${assignment.branch}:agent.txt`), "agent work");
  } finally { await cleanup(f); }
});

test("a replay that would conflict is refused, not resolved", async () => {
  const f = await fixture();
  try {
    const run = await activate(f, "clash");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-clash", identifier: "NEXA-12", runId: run, repositoryPath: f.repositoryPath,
    });
    await writeFile(path.join(assignment.workspacePath, "same.txt"), "the agent's version\n");
    await f.manager.finalizeCommit("issue-clash", run, "NEXA-12");

    // The same file, different content, landed on the branch meanwhile.
    await writeFile(path.join(f.repositoryPath, "same.txt"), "the human's version\n");
    await git(f.repositoryPath, "add", "same.txt");
    await git(f.repositoryPath, "commit", "-m", "feat(app): my version of the file");
    const userHead = await git(f.repositoryPath, "rev-parse", "HEAD");

    const outcome = await f.manager.integrate(run);
    assert.equal(outcome.integrated, false);
    assert.match(outcome.reason ?? "", /conflict/);
    // Nothing half-applied: the user's file and branch are exactly as they were,
    // and their checkout is not sitting mid-rebase.
    assert.equal(await readFile(path.join(f.repositoryPath, "same.txt"), "utf8"), "the human's version\n");
    assert.equal(await git(f.repositoryPath, "rev-parse", "HEAD"), userHead);
    assert.equal(await git(f.repositoryPath, "status", "--porcelain"), "");
  } finally { await cleanup(f); }
});

test("a run that touched nothing has nothing to integrate", async () => {
  const f = await fixture();
  try {
    const run = await activate(f, "idle");
    await f.manager.provision({ projectId: "project", issueId: "issue-idle", identifier: "NEXA-9", runId: run, repositoryPath: f.repositoryPath });
    // An agent that answered without touching a file leaves the branch at base.
    await f.manager.finalizeCommit("issue-idle", run, "NEXA-9");
    const outcome = await f.manager.integrate(run);
    assert.equal(outcome.integrated, false);
    assert.match(outcome.reason ?? "", /no changes/);
    // And no commit to point at. `finalizeCommit` records HEAD regardless, so
    // reporting that as the run's commit is what told a user whose folder was
    // genuinely untouched to `git merge` a branch holding nothing.
    assert.equal(outcome.commit, null);
  } finally { await cleanup(f); }
});

test("integration refuses to merge into a working tree the user is mid-edit on", async () => {
  const f = await fixture();
  try {
    const run = await activate(f, "held");
    const assignment = await f.manager.provision({
      projectId: "project", issueId: "issue-held", identifier: "NEXA-10", runId: run, repositoryPath: f.repositoryPath,
    });
    await writeFile(path.join(assignment.workspacePath, "later.txt"), "agent work\n");
    await f.manager.finalizeCommit("issue-held", run, "NEXA-10");

    // Merging into a dirty tree can overwrite what the user was editing.
    await writeFile(path.join(f.repositoryPath, "shared.txt"), "edited by hand\n");
    const outcome = await f.manager.integrate(run);
    assert.equal(outcome.integrated, false);
    assert.match(outcome.reason ?? "", /uncommitted changes/);
    assert.equal(await readFile(path.join(f.repositoryPath, "shared.txt"), "utf8"), "edited by hand\n");
    await assert.rejects(access(path.join(f.repositoryPath, "later.txt")));
  } finally { await cleanup(f); }
});
