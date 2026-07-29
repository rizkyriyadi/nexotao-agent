import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* Which folders the workspace picker offers.

   Exercised through the real control plane rather than a stub, because the bug
   this file exists to prevent was a disagreement between two records of the same
   fact: the workspace row said a run was still `active` while its heartbeat had
   said `failed` since yesterday. A fake that returns one hand-written row cannot
   reproduce a disagreement between two of them. */

const dir = await mkdtemp(path.join(tmpdir(), "nexotao-roots-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase } = await import("../lib/db/database");
const { ControlPlaneRepositories } = await import("../lib/db/repositories");
const { saveConfig } = await import("../lib/config");
const { addProject } = await import("../lib/store");
const { createIssue } = await import("../lib/issues");
const { listRoots } = await import("../lib/workspace-files");

const projectPath = path.join(dir, "project");
await mkdir(projectPath, { recursive: true });
const project = await addProject({ name: "Nexotao", path: projectPath, mode: "multi", agents: [] });
await saveConfig({ activeProjectId: project.id });

const database = await getDatabase();
const repositories = new ControlPlaneRepositories(database);
const { agents, gitWorkspaces } = await import("../lib/db/schema");

await database.write((db) => {
  db.insert(agents).values({ id: "agent-one", projectId: project.id, name: "Hutao", role: "lead", scope: "all", createdAt: 1, updatedAt: 1 }).run();
});

/** One run with a worktree on disk, in whatever heartbeat state the caller
 *  names. The workspace row is always written as `active` — that is exactly the
 *  state a provisioned worktree is left in, and the state that never advanced
 *  for runs which failed or were cancelled. */
async function seedRun(title: string, status: string) {
  const now = Date.now();
  const issue = await createIssue({ projectId: project.id, title, status: "todo" });
  const heartbeat = await repositories.createHeartbeat({
    agentId: "agent-one", issueId: issue.id, wakeupId: null, source: "assignment", status,
    sessionBefore: null, sessionAfter: null, usage: {}, error: null, workspacePath: null, workspaceBranch: null,
    queuedAt: now, startedAt: now, updatedAt: now, finishedAt: null,
  });
  const workspacePath = path.join(dir, "worktrees", `${issue.ref}-${heartbeat.id}`);
  await mkdir(workspacePath, { recursive: true });
  await database.write((db) => {
    db.insert(gitWorkspaces).values({
      id: `ws-${heartbeat.id}`, projectId: project.id, issueId: issue.id, runId: heartbeat.id,
      repositoryPath: projectPath, workspacePath, branch: `nexotao/${issue.ref.toLowerCase()}/${heartbeat.id}`,
      targetBranch: "main", baseCommit: "0".repeat(40), commitSha: null, state: "active",
      lastValidatedAt: now, recoveryNote: null, createdAt: now, updatedAt: now,
    }).run();
  });
  return { issue, runId: heartbeat.id, workspacePath };
}

after(async () => {
  await database.close();
  await rm(dir, { recursive: true, force: true });
});

/* Why: the workspace row is set to `active` when the worktree is provisioned and
   only advances when the run *commits*. A run that failed, was cancelled, or was
   killed mid-flight leaves that row `active` for good — so a picker keyed on it
   accumulates one dead "working copy" per task ever attempted, each pointing at
   an abandoned checkout. The user reads that as the panel showing a folder per
   task instead of their project. */
test("a run that is no longer writing does not leave a folder in the picker", async () => {
  const failed = await seedRun("Build the landing page", "failed");
  const cancelled = await seedRun("Say halo", "cancelled");
  const succeeded = await seedRun("Ship the thing", "succeeded");

  const roots = await listRoots();
  assert.deepEqual(roots.map((r) => r.kind), ["project"], "only the project folder — every run has stopped");
  for (const dead of [failed, cancelled, succeeded]) {
    assert.ok(
      !roots.some((r) => r.path === dead.workspacePath),
      "a settled run's worktree is history, not a place to look",
    );
  }
});

/* Why: while a run is in flight the agent writes into its worktree, so the
   project folder shows the files as they were before the run started. Hiding the
   worktree then is the opposite failure — the user watches the agent write four
   files and finds none of them. */
test("a run that is still writing is offered alongside the project", async () => {
  const running = await seedRun("Add dark mode", "running");
  const waiting = await seedRun("Wait on the user", "waiting");

  const roots = await listRoots();
  assert.equal(roots[0].kind, "project", "the project folder always leads — it is the one the user recognises");
  const worktrees = roots.filter((r) => r.kind === "worktree");
  assert.equal(worktrees.length, 2, "both live runs, and none of the settled ones seeded above");
  assert.deepEqual(
    worktrees.map((r) => r.path).sort(),
    [running.workspacePath, waiting.workspacePath].sort(),
  );
  assert.match(worktrees[0].label, /· working copy$/, "labelled as a copy, not mistaken for the project");
});

/* Why: the row is the only record that a worktree was ever provisioned, and the
   directory can be gone without it — `nexotao uninstall` releases worktrees,
   and a user can delete one by hand. Offering a folder that is not there yields
   an empty tree and no explanation. */
test("a live run whose worktree has been removed is not offered", async () => {
  const vanished = await seedRun("Vanished mid-run", "running");
  await rm(vanished.workspacePath, { recursive: true, force: true });

  const roots = await listRoots();
  assert.ok(!roots.some((r) => r.path === vanished.workspacePath), "a folder that is not on disk is not a folder to browse");
  assert.ok(roots.some((r) => r.kind === "project"), "and the project folder still is");
});
