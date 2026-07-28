import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";
import { IssueLifecycleService } from "../lib/issue-lifecycle";
import {
  RUN_INTEGRATION_EVENT_TYPE, RUN_RESULT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE,
  TASK_DELEGATED_EVENT_TYPE, TEXT_DELTA_EVENT_TYPES,
  runOutcomeChip, settledIssueStatus,
} from "../lib/run-transcript";
import { relativizeWorkspacePaths } from "../lib/agent";

/* ── the "Done" that wasn't ──────────────────────────────────────────────────
 * A run that exits because it ran out of steps exits *successfully* — the loop
 * simply stops. Reporting that as Done is what filed half-finished work as
 * complete, with an answer that trailed off mid-sentence. */

test("a run that ran out of steps is Paused, not Done", () => {
  const finished = runOutcomeChip({ succeeded: true, truncated: false, cancelled: false });
  assert.deepEqual(finished, { label: "Done", tone: "success" });

  const stopped = runOutcomeChip({ succeeded: true, truncated: true, cancelled: false });
  assert.equal(stopped.label, "Paused");
  // Nothing broke, so it must not be dressed up as a failure either.
  assert.equal(stopped.tone, "neutral");
});

test("cancellation and failure keep their own chips regardless of truncation", () => {
  assert.equal(runOutcomeChip({ succeeded: false, truncated: false, cancelled: true }).label, "Cancelled");
  // Cancelling mid-step is both cancelled and truncated; the user asked for the
  // stop, so that is the story — not "Paused".
  assert.equal(runOutcomeChip({ succeeded: false, truncated: true, cancelled: true }).label, "Cancelled");
  assert.equal(runOutcomeChip({ succeeded: false, truncated: false, cancelled: false }).label, "Failed");
});

test("an unfinished task lands in review rather than done", () => {
  assert.equal(settledIssueStatus({ ok: true, truncated: false, requeue: false }), "done");
  // The regression: truncated work used to be filed as done.
  assert.equal(settledIssueStatus({ ok: true, truncated: true, requeue: false }), "in_review");
  assert.equal(settledIssueStatus({ ok: false, truncated: false, requeue: false }), "in_review");
  // A follow-up that landed mid-run still reopens the task.
  assert.equal(settledIssueStatus({ ok: true, truncated: false, requeue: true }), "todo");
  // …but not at the cost of hiding that the run never finished.
  assert.equal(settledIssueStatus({ ok: true, truncated: true, requeue: true }), "in_review");
});

/* ── the closing report ──────────────────────────────────────────────────── */

test("the closing summary is its own event, not another text delta", () => {
  // Deltas are appended as they stream; the summary is written afterwards in a
  // turn of its own. Were it a delta the transcript would append it to whatever
  // half-sentence preceded it instead of setting it apart.
  assert.ok(!TEXT_DELTA_EVENT_TYPES.has(RUN_SUMMARY_EVENT_TYPE));
  assert.ok(TEXT_DELTA_EVENT_TYPES.has("reasoning_summary"));
});

/* ── delegation ─────────────────────────────────────────────────────────── */

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-delegate-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({
    id: "p", name: "Team", path: dir, mode: "multi", agentSpecs: [], createdAt: 1,
  }).run());
  const repositories = new ControlPlaneRepositories(database);
  await repositories.agents.insert({ id: "lead", projectId: "p", name: "Hutao", role: "lead", scope: "lead", createdAt: 2, updatedAt: 2 });
  await repositories.agents.insert({ id: "dev", projectId: "p", name: "Dev", role: "worker", scope: "engineering", createdAt: 3, updatedAt: 3 });
  const lifecycle = new IssueLifecycleService(database);
  const parent = await lifecycle.create({
    projectId: "p", title: "Ship the thing", assigneeAgentId: "lead", actor: { type: "user" },
  });
  return { dir, database, repositories, lifecycle, parent };
}

test("a delegated sub-task hangs off its parent and is ready to run", async () => {
  const f = await fixture();
  try {
    const child = await f.lifecycle.create({
      projectId: "p", parentId: f.parent.id, title: "Build the billing page",
      description: "Everything the teammate needs", assigneeAgentId: "dev", createdByAgentId: "lead",
      status: "todo", actor: { type: "agent", id: "lead" },
    });

    assert.equal(child.parentId, f.parent.id);
    assert.equal(child.assigneeAgentId, "dev");
    // "todo", not "backlog": the executor's tick only starts todo or blocked
    // work, so a backlog sub-task would sit there forever and the user would be
    // waiting on something that was never going to run.
    assert.equal(child.status, "todo");
    // The ref is what the transcript link shows, so it must be distinct.
    assert.notEqual(child.identifier, f.parent.identifier);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the delegation event carries what a link needs", () => {
  // The transcript renders a clickable card from this payload alone: the id to
  // navigate to, and the ref/title so the user knows which task it is.
  const payload = { id: "abc", ref: "NX-7", title: "Build the billing page", assignee: "Dev" };
  assert.equal(TASK_DELEGATED_EVENT_TYPE, "task_delegated");
  for (const key of ["id", "ref", "title", "assignee"]) {
    assert.ok(key in payload, `${key} travels with the event`);
  }
});

/* ── work the user cannot see ────────────────────────────────────────────────
 * When a run's commit cannot be fast-forwarded into the branch the user works
 * on, their folder looks exactly as they left it while the task reports done.
 * Saying so only in the answer text does not reach them: every text event is
 * written while the agent is still running, and integration is attempted after
 * that. It has to be an event of its own. */

test("the unintegrated-work notice is its own event, not text", () => {
  // Not a delta — appending it would glue it onto the agent's last half-sentence.
  assert.ok(!TEXT_DELTA_EVENT_TYPES.has(RUN_INTEGRATION_EVENT_TYPE));
  // And distinct from the two events that already exist, one of which is never
  // rendered at all.
  assert.notEqual(RUN_INTEGRATION_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE);
  assert.notEqual(RUN_INTEGRATION_EVENT_TYPE, RUN_RESULT_EVENT_TYPE);
});

test("the notice is emitted for a refusal and withheld for a clean merge", () => {
  // The executor's rule, stated once here so it cannot drift: a refusal that
  // produced a commit is the only case the user must be told about. A clean
  // merge needs no notice (the files are simply there), and a run that changed
  // nothing has no commit to point at — a `git merge` line for either would send
  // the user chasing work that does not exist.
  const shouldNotify = (i: { commit: string | null; reason?: string }) => Boolean(i.reason && i.commit);
  assert.ok(shouldNotify({ commit: "abc123", reason: "your working tree has uncommitted changes" }));
  assert.ok(!shouldNotify({ commit: "abc123" }));
  assert.ok(!shouldNotify({ commit: null, reason: "the run made no changes" }));
});

/* ── the hand-off that wrote into the wrong copy ─────────────────────────────
 * Each run works in its own copy of the project. A lead that pastes its own
 * absolute workspace path into a sub-task sends the teammate somewhere outside
 * that teammate's workspace: the write succeeds, the teammate reports done, its
 * branch is empty, and the user is told three files were created while their
 * folder holds none. Nothing downstream can detect this — the run genuinely had
 * no changes to integrate — so it has to be stopped at the hand-off. */

test("a delegated brief never carries the lead's own workspace path", () => {
  const root = "/home/user/.nexotao/worktrees/abc123/nx-12-9b7ddca6";
  const brief = relativizeWorkspacePaths(
    `Create a file called ROUTING.md in the repo root at ${root}/ROUTING.md. Also update ${root}/docs/index.md.`,
    root,
  );
  assert.ok(!brief.includes(root), "the lead's workspace is gone from the brief");
  assert.match(brief, /called ROUTING\.md in the repo root at ROUTING\.md/);
  assert.match(brief, /update docs\/index\.md/);
});

test("relativizing leaves a brief that never mentioned the workspace alone", () => {
  const root = "/home/user/.nexotao/worktrees/abc123/nx-12-9b7ddca6";
  const brief = "Create ROUTING.md in the repo root. Cover redirects and 404s.";
  assert.equal(relativizeWorkspacePaths(brief, root), brief);
  // A bare root with no trailing slash still resolves to "the project", not "".
  assert.equal(relativizeWorkspacePaths(`Work inside ${root} only.`, root), "Work inside . only.");
});
