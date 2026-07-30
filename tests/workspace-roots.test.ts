import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

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
const { activeRoot, listRoots, pendingWork } = await import("../lib/workspace-files");

const projectPath = path.join(dir, "project");
await mkdir(projectPath, { recursive: true });
const project = await addProject({ name: "Nexotao", path: projectPath });
await saveConfig({ activeProjectId: project.id });

const database = await getDatabase();
const repositories = new ControlPlaneRepositories(database);
const { agents, gitWorkspaces, heartbeatRuns } = await import("../lib/db/schema");

await database.write((db) => {
  db.insert(agents).values({ id: "agent-one", projectId: project.id, name: "Hutao", role: "lead", scope: "all", createdAt: 1, updatedAt: 1 }).run();
});

/** One run with a worktree on disk, in whatever heartbeat state the caller
 *  names. The workspace row is always written as `active` — that is exactly the
 *  state a provisioned worktree is left in, and the state that never advanced
 *  for runs which failed or were cancelled. */
async function seedRun(title: string, status: string, workspaceState = "active") {
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
      targetBranch: "main", baseCommit: "0".repeat(40), commitSha: null, state: workspaceState,
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

/* Why: this is the complaint in the user's own words — "kenapa setiap run/prompt
   foldering nya beda?". The panel used to offer the project folder *and* a
   working copy per live run and make the user choose, so the answer to "where
   are my files?" changed shape every task. There is one project; a worktree is
   an implementation detail of running safely. Exactly one folder is shown, and
   nobody is asked to pick. */
test("one folder is shown, never a choice between them", async () => {
  await seedRun("Add dark mode", "running");
  await seedRun("Wait on the user", "waiting");

  const root = await activeRoot();
  assert.ok(root, "a folder is always resolved while a project is open");
  assert.equal(typeof root!.path, "string");
});

/* Why: while a run is in flight the agent writes into its worktree, so the
   project folder genuinely shows the files as they were before the run started.
   Showing it then is the failure the user reported first — watching the agent
   write eight files and finding none of them. */
test("the folder follows the live run while it writes", async () => {
  const running = await seedRun("Build the landing page", "running");

  const root = await activeRoot();
  assert.equal(root?.kind, "worktree", "the agent is writing here, so this is where the files are");
  assert.equal(root?.path, running.workspacePath);
});

/* Why: the handover is the whole point of choosing rather than asking. A run's
   last act is to fast-forward its work into the project folder, so once it
   settles the worktree is history and the project folder is the truthful answer.
   If the panel stayed on the worktree the user would be left staring at a
   temporary directory that no longer receives writes. */
test("the folder returns to the project once the run settles", async () => {
  const run = await seedRun("Build the landing page", "running");
  assert.equal((await activeRoot())?.path, run.workspacePath, "the run is live, so the panel is on its working copy");

  // Every run seeded by the tests above, not just this one: the handover only
  // happens when nothing is writing any more.
  await database.write((db) => {
    db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: Date.now() }).run();
  });

  const root = await activeRoot();
  assert.equal(root?.kind, "project", "the run has landed its work, so the project folder is the answer");
  assert.equal(root?.path, projectPath, "and no user action was needed to get back here");
});

/* Why: `integrate` refuses to force a merge when the user's own tree has
   uncommitted changes — correctly, that work is theirs. But the run reported
   success, so the files are somewhere the folder view cannot see. Saying nothing
   makes a truthful agent look like a lying one. */
test("work that never reached the project folder is reported, with where to find it", async () => {
  const stranded = await seedRun("Ship the thing", "succeeded", "rejected");
  await database.write((db) => {
    db.update(gitWorkspaces)
      .set({ commitSha: "f".repeat(40), recoveryNote: "your working tree has uncommitted changes" })
      .where(eq(gitWorkspaces.id, `ws-${stranded.runId}`)).run();
  });

  const notice = await pendingWork();
  assert.ok(notice, "a refusal the user was never told about is indistinguishable from lost work");
  assert.equal(notice!.reference, stranded.issue.ref);
  assert.match(notice!.reason, /uncommitted changes/, "the reason is the one git gave, not a guess");
  assert.ok(notice!.branch.startsWith("nexotao/"), "and the branch is named so the work can be recovered");
});

/* Why: the record of a refusal is written once and never revised, so a notice
   keyed on it alone would nag forever about work the user merged by hand
   minutes later. Git is asked whether the commit is already in HEAD, which is
   exact and clears itself. */
test("a stranded commit that has since been merged stops being reported", async () => {
  const merged = await seedRun("Already merged by hand", "succeeded", "rejected");
  const repository = path.join(dir, "merged-repo");
  await mkdir(repository, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "the run's work, merged by hand");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository }).toString().trim();
  await database.write((db) => {
    db.update(gitWorkspaces).set({ commitSha: head, repositoryPath: repository })
      .where(eq(gitWorkspaces.id, `ws-${merged.runId}`)).run();
  });

  const notice = await pendingWork();
  assert.notEqual(notice?.reference, merged.issue.ref, "the commit is in HEAD — there is nothing left to tell the user");
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
