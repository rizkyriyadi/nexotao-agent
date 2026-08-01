import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* The route reaches the config file, the database and the snapshot module's
   scratch-index directory — all three anchored to NEXOTAO_DATA_DIR at module
   load. So the variable is set first and every import below is dynamic, to make
   that ordering a fact about this file rather than about hoisting. */
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-changes-"));
process.env.NEXOTAO_DATA_DIR = path.join(dir, "data");

const { GET, POST } = await import("../app/api/issues/[id]/changes/route");
const { capture, listSnapshots } = await import("../lib/run-snapshot");
const { awaitsReview } = await import("../lib/run-transcript");
const { getDatabase } = await import("../lib/db/database");
const { ControlPlaneRepositories } = await import("../lib/db/repositories");
const { addProject } = await import("../lib/store");
const { saveConfig } = await import("../lib/config");
const { createIssue, getIssue, seedAgents } = await import("../lib/issues");

const exec = promisify(execFile);
let seq = 0;

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

/** Everything one case needs: a real repository as the project folder, a run row
 *  carrying a real snapshot of it, and an issue parked where the run left it.
 *
 *  The issue is created directly in `in_review` and left unassigned on purpose.
 *  `in_review` because `keep` and `revert` both call `updateIssue(…, "done")`,
 *  and the transition table has no `todo → done` edge — a fixture that started
 *  in `todo` would fail on the lifecycle, not on the behaviour under test.
 *  Unassigned because `revert-retry` ends in `tick()`, which drains the real
 *  heartbeat runtime against `NEXOTAO_BASE`; `tick` skips issues with no
 *  assignee, so leaving it null is what keeps these tests off the network. The
 *  agent row itself still has to exist — `heartbeat_runs.agent_id` is NOT NULL,
 *  because a run without an agent is not a thing the app can produce. */
async function scenario(options: { status?: "in_review" | "done"; snapshot?: boolean } = {}) {
  seq += 1;
  const root = path.join(dir, `repo-${seq}`);
  await mkdir(root, { recursive: true });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@nexotao.test");
  await writeFile(path.join(root, "tracked.txt"), "before the run\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "chore(repo): initialize fixture");

  const project = await addProject({ name: `Project ${seq}`, path: root });
  await saveConfig({ activeProjectId: project.id });

  const [agent] = await seedAgents(project.id);
  const issue = await createIssue({ projectId: project.id, title: `Work ${seq}`, status: options.status ?? "in_review" });
  const repositories = new ControlPlaneRepositories(await getDatabase());
  const run = await repositories.createHeartbeat({
    agentId: agent.id, issueId: issue.id, source: "assignment", status: "done", startedAt: Date.now(),
  });

  let snapshotCommit: string | null = null;
  if (options.snapshot !== false) {
    const snapshot = await capture(root, run.id);
    assert.equal(snapshot.available, true, "the fixture's own snapshot must succeed");
    if (snapshot.available) {
      snapshotCommit = snapshot.commit;
      await repositories.recordSnapshot(run.id, snapshot.commit, snapshot.head);
    }
  }
  return { root, project, issue, run, repositories, snapshotCommit };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function readChanges(id: string) {
  const response = await GET(new Request("http://local/api/issues/x/changes"), params(id));
  return { status: response.status, body: await response.json() };
}

async function act(id: string, body: Record<string, unknown>) {
  const response = await POST(
    new Request("http://local/api/issues/x/changes", { method: "POST", body: JSON.stringify(body) }),
    params(id),
  );
  return { status: response.status, body: await response.json() };
}

/* ── which mode decides what, and nothing else does ──────────────────────────
 * The rule used to be "did the agent leave a commit on its branch", which no
 * longer exists to ask. It is two facts now — did the run change anything, and
 * which mode is the user in — and they are stated in one function so the answer
 * can be read rather than reproduced by running an agent against the network. */

test("a run that changed files parks the task, unless the user asked it not to", () => {
  assert.equal(awaitsReview(3, "review"), true);
  assert.equal(awaitsReview(3, undefined), true, "review is the default — an absent setting must not mean auto");
  assert.equal(awaitsReview(3, "auto"), false, "auto finishes the task; the diff is still there to open");
});

test("a run that changed nothing finishes in either mode", () => {
  // An empty diff is not a decision. Asking someone to review one is how a
  // review prompt turns into a thing you learn to click past without reading.
  assert.equal(awaitsReview(0, "review"), false);
  assert.equal(awaitsReview(0, "auto"), false);
});

/* Why: in auto mode the task is `done` and out of the inbox, but the folder was
   still written to. If the snapshot were dropped along with the review state,
   auto would quietly mean "no undo" — which is not what the setting says. */
test("auto mode finishes the task and still offers the diff and the revert", async () => {
  const { root, issue } = await scenario({ status: "done" });
  await saveConfig({ reviewMode: "auto" });
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");

  const { status, body } = await readChanges(issue.id);
  assert.equal(status, 200);
  assert.equal(body.snapshot.available, true, "the safety net outlives the review state");
  assert.deepEqual(body.files.map((file: any) => file.path), ["added-by-agent.ts"]);
  await saveConfig({ reviewMode: "review" });
});

/* ── the diff itself ─────────────────────────────────────────────────────── */

test("the diff reports created, modified and deleted files alike", async () => {
  const { root, issue } = await scenario();
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "tracked.txt"), "rewritten by the agent\n");

  const { body } = await readChanges(issue.id);
  const byPath = new Map<string, any>(body.files.map((file: any) => [file.path, file]));
  assert.equal(byPath.get("added-by-agent.ts")?.status, "A");
  assert.equal(byPath.get("added-by-agent.ts")?.oldText, "", "a created file has no before-text");
  assert.equal(byPath.get("added-by-agent.ts")?.newText, "export const x = 1;\n");
  assert.equal(byPath.get("tracked.txt")?.status, "M");
  assert.equal(byPath.get("tracked.txt")?.oldText, "before the run\n", "the before-text comes from the snapshot, not from HEAD");
  assert.equal(body.truncated, false);
});

/* Why: the diff is computed on read rather than stored at the end of the run.
   That costs a `write-tree` per request and buys the only honest answer — the
   user can edit the same folder while the panel is open, and a stored diff would
   go on describing a folder that no longer exists. */
test("the diff reflects edits the user made after the run finished", async () => {
  const { root, issue } = await scenario();
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");
  assert.equal((await readChanges(issue.id)).body.files.length, 1);

  await writeFile(path.join(root, "mine.txt"), "I typed this myself\n");
  const after = await readChanges(issue.id);
  assert.deepEqual(
    after.body.files.map((file: any) => file.path).sort(),
    ["added-by-agent.ts", "mine.txt"],
  );
});

/* Why: a task with no run behind it is the ordinary state of most of the board,
   and the panel is mounted for all of them. It has to render "nothing to show"
   rather than fail. */
test("a task with no snapshot reports an absent safety net rather than an error", async () => {
  const { issue } = await scenario({ snapshot: false });

  const { status, body } = await readChanges(issue.id);
  assert.equal(status, 200);
  assert.equal(body.snapshot.available, false);
  assert.equal(body.snapshot.reason, "no_run");
  assert.deepEqual(body.files, []);

  // And no decision can be taken on it, because there is nothing to take it on.
  const refused = await act(issue.id, { action: "keep" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /no snapshot/i);
});

/* ── the three buttons ───────────────────────────────────────────────────── */

test("keep finishes the task, leaves the files alone, and releases the snapshot", async () => {
  const { root, issue, repositories } = await scenario();
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");

  const { status, body } = await act(issue.id, { action: "keep" });
  assert.equal(status, 200);
  assert.equal(body.kept, true);
  assert.equal(body.issue.status, "done");
  assert.equal(
    await readFile(path.join(root, "added-by-agent.ts"), "utf8"), "export const x = 1;\n",
    "keeping is a decision about the task, not a write to the folder",
  );
  // The ref is what pinned the snapshot commit against gc; the decision is made,
  // so it goes. `latestSnapshotForIssue` no longer offers a revert on it.
  assert.deepEqual(await listSnapshots(root), []);
  assert.equal(repositories.latestSnapshotForIssue(issue.id), null);
});

test("revert puts the folder back exactly as it was and finishes the task", async () => {
  const { root, issue } = await scenario();
  const before = await git(root, "status", "--porcelain");
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "tracked.txt"), "rewritten by the agent\n");

  const { status, body } = await act(issue.id, { action: "revert" });
  assert.equal(status, 200);
  assert.equal(body.issue.status, "done");
  assert.match(body.issue.summary, /reverted/i, "the board says what happened, not just that it ended");

  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "before the run\n", "a modified file is restored");
  await assert.rejects(() => readFile(path.join(root, "added-by-agent.ts"), "utf8"), "a created file is removed");
  assert.equal(await git(root, "status", "--porcelain"), before, "and git sees the folder it saw before the run");
});

/* Why: this is the button for "close, but not like that". Reverting without
   recording the reason would send the agent back at the same task with the same
   information, which is how a retry loop repeats itself. */
test("revert and retry records the reason, reopens the task, and restores the folder", async () => {
  const { root, issue } = await scenario();
  const { repositories } = { repositories: new ControlPlaneRepositories(await getDatabase()) };
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");

  const { status, body } = await act(issue.id, { action: "revert-retry", reason: "Use the existing helper instead" });
  assert.equal(status, 201);
  assert.equal(body.issue.status, "todo", "reopened, not filed as done");
  await assert.rejects(() => readFile(path.join(root, "added-by-agent.ts"), "utf8"));
  assert.deepEqual(
    repositories.listComments(issue.id).map((row) => row.body),
    ["Use the existing helper instead"],
    "the next run reads this as the reason it is running again",
  );
});

/* Why: the check runs before the restore, not after. A blank reason that still
   wiped the folder would be the worst of both — work destroyed, and the agent
   told nothing about why. */
test("revert and retry without a reason changes nothing at all", async () => {
  const { root, issue } = await scenario();
  await writeFile(path.join(root, "added-by-agent.ts"), "export const x = 1;\n");

  const blank = await act(issue.id, { action: "revert-retry", reason: "   " });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /what to change/i);
  assert.equal(
    await readFile(path.join(root, "added-by-agent.ts"), "utf8"), "export const x = 1;\n",
    "the refusal came before the restore",
  );
  assert.equal((await getIssue(issue.id))?.status, "in_review", "and the task is still waiting");
  assert.equal((await listSnapshots(root)).length, 1, "with its safety net intact");
});
