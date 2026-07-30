/* Which board column an issue renders in — the default set, and the rule that
   places a card in one of them.

   This module has no runtime imports at all. That is deliberate: the database
   bootstrap and the client both read the default columns from here, so a single
   `import` of the database would drag sql.js into the browser bundle and let the
   two surfaces disagree about what the board shows. Keep it that way. */

/** The board column shape this module reconciles against — the row as stored
 *  in `workflow_states`, narrowed to the fields the placement rule reads. */
export type WorkflowState = { id: string; projectId: string; name: string; statusGroup: string; position: number };

/* Every project gets these five board columns, and every issue is placed in the
   column matching its current status.

   `blocked` and `cancelled` have no column of their own: blocked work still
   belongs under Todo (it is waiting, not elsewhere) and cancelled work under
   Done (it is finished, just not successfully). Their `status` is untouched —
   only the column they render in is decided here. */
export const DEFAULT_WORKFLOW_STATES = [
  { key: "backlog", name: "Backlog", group: "backlog", color: "#94a3b8", position: 1 },
  { key: "todo", name: "Todo", group: "todo", color: "#6366f1", position: 2 },
  { key: "in_progress", name: "In Progress", group: "in_progress", color: "#f59e0b", position: 3 },
  { key: "in_review", name: "In Review", group: "in_review", color: "#8b5cf6", position: 4 },
  { key: "done", name: "Done", group: "done", color: "#10b981", position: 5 },
] as const;

/** Which default column an existing status renders in. */
export const STATUS_TO_DEFAULT_STATE: Record<string, string> = {
  backlog: "backlog", todo: "todo", blocked: "todo", in_progress: "in_progress",
  in_review: "in_review", done: "done", cancelled: "done",
};

/** Deterministic id so the seed is idempotent across re-runs and re-installs. */
export const defaultStateId = (projectId: string, key: string) => `${projectId}:state:${key}`;

/** Which column an issue actually belongs in.
 *
 *  The lifecycle changes `status` on its own — checkout moves work to
 *  `in_progress`, `wakeDependents` promotes `blocked → todo`, a run finishes into
 *  `done` — and none of those paths know about board columns. Reconciling here
 *  instead of writing `stateId` from inside the lifecycle keeps the engine free of
 *  presentation concerns and means the board can never show a column that
 *  contradicts the status: a stored column is honoured only while its group still
 *  matches, so a user's custom "Code Review" column survives, but a stale one is
 *  replaced by the default column for the current status. */
export function resolveStateId(issue: { status: string; stateId: string | null; projectId: string }, states: WorkflowState[]): string | null {
  const stored = issue.stateId ? states.find((state) => state.id === issue.stateId) : undefined;
  if (stored && stored.statusGroup === issue.status) return stored.id;
  const key = STATUS_TO_DEFAULT_STATE[issue.status];
  const fallback = states.find((state) => state.id === defaultStateId(issue.projectId, key))
    ?? states.find((state) => state.statusGroup === issue.status);
  return fallback?.id ?? stored?.id ?? null;
}
