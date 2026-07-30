import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_EXCLUSION_EVENT_TYPE, RUN_INTEGRATION_EVENT_TYPE, RUN_RESULT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE,
  TEXT_DELTA_EVENT_TYPES, runOutcomeChip, settledIssueStatus,
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

/* ── files held back from the commit ─────────────────────────────────────────
 * Agent-instruction Markdown is excluded rather than committed, which is right,
 * but it used to be excluded in silence. The gap the last test describes is the
 * reason: the integration notice needs a commit to point at, and a run whose
 * every changed path was excluded produces none. So the one case where the user
 * has the least to go on — a folder that never changed — was the case nothing
 * was reported for. */

test("held-back files are reported independently of integration", () => {
  // Its own event for the same reason the integration notice is: it is decided
  // after the agent has stopped, so text added then never reaches the transcript.
  assert.ok(!TEXT_DELTA_EVENT_TYPES.has(RUN_EXCLUSION_EVENT_TYPE));
  for (const other of [RUN_INTEGRATION_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE, RUN_RESULT_EVENT_TYPE]) {
    assert.notEqual(RUN_EXCLUSION_EVENT_TYPE, other);
  }

  // The executor's rule: exclusions are reported whenever there are any. It is
  // deliberately NOT conditioned on the commit, which is what made the
  // everything-excluded run silent.
  const shouldReport = (i: { excluded: string[]; commit: string | null }) => i.excluded.length > 0;
  assert.ok(shouldReport({ excluded: ["AGENTS.md"], commit: null }), "no commit is exactly when it matters");
  assert.ok(shouldReport({ excluded: ["AGENTS.md"], commit: "abc123" }), "and it still matters alongside one");
  assert.ok(!shouldReport({ excluded: [], commit: "abc123" }));
});

/* ── text that points into a folder that is gone ─────────────────────────────
 * Each run works in its own copy of the project, at a path that stops existing
 * once the run is cleaned up. Anything the run writes down for later — a task
 * detail, a plan, a summary — that quotes that absolute path sends its next
 * reader, whether the following run or the user in their own folder, to a
 * directory that is not there. The relative path is the one that stays true. */

test("run-written text never carries the run's own workspace path", () => {
  const root = "/home/user/.nexotao/worktrees/abc123/nx-12-9b7ddca6";
  const detail = relativizeWorkspacePaths(
    `Create a file called ROUTING.md in the repo root at ${root}/ROUTING.md. Also update ${root}/docs/index.md.`,
    root,
  );
  assert.ok(!detail.includes(root), "the run's workspace is gone from the text");
  assert.match(detail, /called ROUTING\.md in the repo root at ROUTING\.md/);
  assert.match(detail, /update docs\/index\.md/);
});

/* Why: the guard above matched a `/`-delimited root only, so on Windows — where
 * the root arrives as `D:\…\worktrees\…` — it stripped nothing and every line
 * the run wrote kept its absolute path. That is the failure this whole function
 * exists to prevent, reappearing on the one platform where the user reporting it
 * was working. The model is told to write POSIX paths and often does, so both
 * spellings of the same root have to go. */
test("a Windows workspace path is stripped in either spelling", () => {
  const root = "D:\\platform vendore\\devi ardiani\\vendora\\.nexotao\\worktrees\\nx-1-9b7ddca6";
  const posix = root.replace(/\\/g, "/");
  // Both spellings appear in one line because that is what actually happens: the
  // root is handed to us backslashed by the host, while the model — told to
  // write POSIX paths — echoes it back with forward slashes.
  const detail = relativizeWorkspacePaths(
    `Create ${root}\\ROUTING.md and update ${posix}/docs/index.md.`,
    root,
  );
  assert.ok(!detail.includes(root), "the backslashed root is gone");
  assert.ok(!detail.includes(posix), "and so is the same root written with forward slashes");
  assert.match(detail, /Create ROUTING\.md/);
  assert.match(detail, /update docs\/index\.md/);
});

test("relativizing leaves text that never mentioned the workspace alone", () => {
  const root = "/home/user/.nexotao/worktrees/abc123/nx-12-9b7ddca6";
  const detail = "Create ROUTING.md in the repo root. Cover redirects and 404s.";
  assert.equal(relativizeWorkspacePaths(detail, root), detail);
  // A bare root with no trailing slash still resolves to "the project", not "".
  assert.equal(relativizeWorkspacePaths(`Work inside ${root} only.`, root), "Work inside . only.");
});
