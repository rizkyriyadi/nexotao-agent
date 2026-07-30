import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKFLOW_STATES, defaultStateId, resolveStateId, type WorkflowState,
} from "../lib/board-columns";

// Pure module — no database, no data dir. Everything here is a plain literal.

const PROJECT = "p1";

const states: WorkflowState[] = DEFAULT_WORKFLOW_STATES.map((state) => ({
  id: defaultStateId(PROJECT, state.key), projectId: PROJECT, name: state.name,
  statusGroup: state.group, position: state.position,
}));
const column = (key: string) => defaultStateId(PROJECT, key);

/** The three fields the placement rule reads, and nothing else. */
const issue = (partial: { status?: string; stateId?: string | null } = {}) =>
  ({ projectId: PROJECT, status: "todo", stateId: column("todo"), ...partial });

test("an issue renders in the column matching its status, and blocked work waits under Todo", () => {
  assert.equal(resolveStateId(issue({ status: "backlog", stateId: column("backlog") }), states), column("backlog"));
  // `blocked` and `cancelled` have no column of their own.
  assert.equal(resolveStateId(issue({ status: "blocked", stateId: null }), states), column("todo"));
  assert.equal(resolveStateId(issue({ status: "cancelled", stateId: null }), states), column("done"));
});

test("a custom column survives only while its group still matches the status", () => {
  const review: WorkflowState = { id: "custom-qa", projectId: PROJECT, name: "QA", statusGroup: "in_review", position: 6 };
  const all = [...states, review];
  assert.equal(resolveStateId(issue({ status: "in_review", stateId: review.id }), all), review.id, "two columns may share a group");
  // The lifecycle moved the work on without knowing about columns.
  assert.equal(resolveStateId(issue({ status: "done", stateId: review.id }), all), column("done"));
});

test("with no columns at all an issue resolves to nothing rather than throwing", () => {
  assert.equal(resolveStateId(issue({ status: "todo", stateId: null }), []), null);
});
