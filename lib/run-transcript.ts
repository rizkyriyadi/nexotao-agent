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

/** The run is about to write to the user's folder with no way back: the
 * before-picture could not be taken. Git missing, the folder unreadable, a
 * hashing pass that timed out on a huge working tree — the run goes ahead
 * regardless, because a run without a safety net is still a run, but it says so
 * rather than letting the user assume Revert is there. Payload:
 * `{ reason, detail }`. */
export const RUN_SNAPSHOT_EVENT_TYPE = "snapshot";

/** Files the run tried to write and was refused, because agent-instruction
 * Markdown is local-only. It has to be its own event rather than a line appended
 * to the answer: the answer streams as `reasoning_summary` deltas and the
 * closing report is emitted as `summary`, both while the agent is still running,
 * so text added to either afterwards reaches the database but never the
 * transcript the user is reading.
 *
 * It is also the one outcome the review notice below cannot describe. A run
 * whose every attempted write was refused changes nothing, so it produces no
 * review notice at all — leaving the user an unchanged folder and a summary
 * claiming the files were written. Payload: `{ files: string[] }`. */
export const RUN_EXCLUSION_EVENT_TYPE = "exclusion";

/** The run changed files in the user's project folder and the task is parked
 * until they have looked. The files are already there either way — this is not
 * a gate holding work back, it is a question about whether to keep it. Emitted
 * only in `review` mode; in `auto` the task simply finishes and the diff stays
 * available. Payload: `{ files: string[] }`. */
export const RUN_REVIEW_EVENT_TYPE = "review";

/** Whether a finished run parks its task for the user to look, or lets it
 * close on the agent's own say-so.
 *
 * Two inputs and no others: did the run change anything, and which mode is the
 * user in. A run that touched nothing has nothing to show, so it finishes in
 * either mode — asking someone to review an empty diff is how a review prompt
 * becomes noise to click past. In `auto` the task finishes regardless; the
 * Changes panel and Revert are still there, they are simply not in anyone's way.
 *
 * Lives here rather than inline in the executor so the rule can be stated once
 * and read back, instead of being a condition only reachable by running an
 * agent against the network. */
export function awaitsReview(changedFiles: number, reviewMode: string | undefined) {
  return changedFiles > 0 && reviewMode !== "auto";
}

/** How a run's agent loop ended. `complete` — the agent stopped on its own;
 * `truncated` — it was still working when it ran into a ceiling, either the
 * step limit or its output size limit too many turns in a row. The difference
 * decides whether the task may be called done. */
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
 * instead of finding it filed as done.
 *
 * `review` is the other road to the same place, and it is not a failure at all:
 * the run succeeded and changed files in the user's folder, and they have not
 * yet said whether to keep them. In `review` mode a run that produced changes is
 * never `done` on its own say-so; in `auto` mode the caller simply never passes
 * the flag. */
export function settledIssueStatus(input: { ok: boolean; truncated: boolean; requeue: boolean; review?: boolean }):
  "done" | "todo" | "in_review" {
  if (!input.ok || input.truncated) return "in_review";
  // A follow-up arrived mid-run and is still unanswered — reopen, don't close.
  // It outranks the review gate: there is no point asking about work the user
  // has already asked to change, and the next run inherits the same commit.
  if (input.requeue) return "todo";
  return input.review ? "in_review" : "done";
}
