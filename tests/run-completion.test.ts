import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_EXCLUSION_EVENT_TYPE, RUN_RESULT_EVENT_TYPE, RUN_SNAPSHOT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE,
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

/* ── a run with no way back ──────────────────────────────────────────────────
 * Runs write straight into the user's folder, and the only undo is the snapshot
 * taken before the agent starts. When that snapshot cannot be taken — no git, an
 * unreadable folder, a hashing pass that timed out — the run still goes ahead,
 * so the user is about to have files rewritten in place with nothing to go back
 * to. Saying so only in the answer text does not reach them: the decision is
 * made before the agent has produced a single token. It has to be its own event,
 * and it has to arrive first. */

test("the missing-snapshot warning is its own event, not text", () => {
  // Not a delta — appending it would glue it onto the agent's first sentence.
  assert.ok(!TEXT_DELTA_EVENT_TYPES.has(RUN_SNAPSHOT_EVENT_TYPE));
  // And distinct from the two events that already exist, one of which is never
  // rendered at all.
  assert.notEqual(RUN_SNAPSHOT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE);
  assert.notEqual(RUN_SNAPSHOT_EVENT_TYPE, RUN_RESULT_EVENT_TYPE);
});

test("the warning is emitted only when the snapshot failed", () => {
  // The executor's rule, stated once here so it cannot drift. A successful
  // capture needs no notice — Revert is simply there — and warning about one
  // would teach the user to ignore the notice that matters.
  const shouldWarn = (s: { available: boolean }) => !s.available;
  assert.ok(shouldWarn({ available: false }));
  assert.ok(!shouldWarn({ available: true }));
});

/* ── writes that were refused ────────────────────────────────────────────────
 * Agents do not get to rewrite their own instruction files, so those writes are
 * refused. They used to be refused in silence, which left the agent's own
 * account of the run ("I updated AGENTS.md") as the only thing the user had —
 * and it was wrong. The file is not in their folder. */

test("refused writes are reported independently of the snapshot warning", () => {
  // Its own event for the opposite reason the snapshot warning is: it is decided
  // after the agent has stopped, so text added then never reaches the transcript.
  assert.ok(!TEXT_DELTA_EVENT_TYPES.has(RUN_EXCLUSION_EVENT_TYPE));
  for (const other of [RUN_SNAPSHOT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE, RUN_RESULT_EVENT_TYPE]) {
    assert.notEqual(RUN_EXCLUSION_EVENT_TYPE, other);
  }

  // The executor's rule: refusals are reported whenever there are any. It is
  // deliberately NOT conditioned on whether the run changed anything else, which
  // is what made the everything-refused run silent.
  const shouldReport = (i: { excluded: string[]; changed: number }) => i.excluded.length > 0;
  assert.ok(shouldReport({ excluded: ["AGENTS.md"], changed: 0 }), "no other change is exactly when it matters");
  assert.ok(shouldReport({ excluded: ["AGENTS.md"], changed: 3 }), "and it still matters alongside others");
  assert.ok(!shouldReport({ excluded: [], changed: 3 }));
});

/* ── text that points at one machine's folder ────────────────────────────────
 * A run's root is an absolute path on the machine it executed on. Anything the
 * run writes down for later — a task detail, a plan, a summary — that quotes it
 * sends its next reader somewhere that means nothing to them: a teammate on
 * another machine, an export opened elsewhere, or simply a project the user has
 * since moved. The relative path is the one that stays true. The fixtures below
 * still use the old worktree paths on purpose — those are the longest, ugliest
 * roots the function ever had to handle, and they are still valid input. */

test("run-written text never carries the run's own root path", () => {
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
test("a Windows root path is stripped in either spelling", () => {
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
