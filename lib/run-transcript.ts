/* The transcript contract shared by the executor (writer), the task view
   (reader) and the replay tests. Imports nothing on purpose: the client bundle
   needs it and lib/run-events.ts pulls in Node-only redaction. */

/** Durable event types that carry *incremental* assistant text. A transcript
 * appends these and only these. */
export const TEXT_DELTA_EVENT_TYPES = new Set(["reasoning_summary", "text"]);

/** The run's final answer, emitted once when the agent finishes. It repeats the
 * deltas above verbatim, so it is stored for consumers that want the whole
 * answer in one row and never appended to a transcript — rendering both is what
 * made a replayed run show the entire answer twice. */
export const RUN_RESULT_EVENT_TYPE = "result";

/** The closing report: a short summary the agent writes *after* its work, in a
 * turn of its own with no tools available. Unlike `result` this is new text, not
 * a repeat of the deltas, so a transcript both stores AND renders it — as the
 * one block that tells the user what actually happened. */
export const RUN_SUMMARY_EVENT_TYPE = "summary";

/** A task the lead handed to someone else, emitted by the `delegate` tool so the
 * transcript can render a link the user can follow. Payload: `{ id, ref, title,
 * assignee }`. */
export const TASK_DELEGATED_EVENT_TYPE = "task_delegated";

/** How a run's agent loop ended. `complete` — the agent stopped on its own;
 * `truncated` — it was still working when it hit the step ceiling. The
 * difference decides whether the task may be called done. */
export type RunCompletion = "complete" | "truncated";

/** The chip that closes out a run section. Kept here, next to the completion
 * type it reads, because "a truncated run must not say Done" is the rule this
 * whole contract exists to enforce — a run that exited cleanly but ran out of
 * steps did not finish the work, and calling that success is what made tasks
 * look complete while their answer trailed off mid-sentence. */
export function runOutcomeChip(input: { succeeded: boolean; truncated: boolean; cancelled: boolean }):
  { label: "Done" | "Paused" | "Cancelled" | "Failed"; tone: "success" | "neutral" | "error" } {
  if (input.cancelled) return { label: "Cancelled", tone: "neutral" };
  if (!input.succeeded) return { label: "Failed", tone: "error" };
  // Nothing broke, so this is not an error — the work simply is not finished.
  if (input.truncated) return { label: "Paused", tone: "neutral" };
  return { label: "Done", tone: "success" };
}

/** Where a task lands once its run settles. `in_review` is the honest home for
 * work that stopped early: the user can read what happened and continue it,
 * instead of finding it filed as done. */
export function settledIssueStatus(input: { ok: boolean; truncated: boolean; requeue: boolean }):
  "done" | "todo" | "in_review" {
  if (!input.ok || input.truncated) return "in_review";
  // A follow-up arrived mid-run and is still unanswered — reopen, don't close.
  return input.requeue ? "todo" : "done";
}
