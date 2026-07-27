import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKFLOW_STATES, UNGROUPED, applyFilters, buildView, defaultStateId,
  groupIssues, nextSequence, orderIssues, resolveStateId,
  type ViewIssue,
} from "../lib/work-view";
import type { Cycle, Label, Module, WorkflowState } from "../lib/work-model";

// Pure module — no database, no data dir. Everything here is a plain literal.

const PROJECT = "p1";

const states: WorkflowState[] = DEFAULT_WORKFLOW_STATES.map((state) => ({
  id: defaultStateId(PROJECT, state.key), projectId: PROJECT, name: state.name,
  statusGroup: state.group, color: state.color, position: state.position, isDefault: true,
}));
const column = (key: string) => defaultStateId(PROJECT, key);

let counter = 0;
function issue(partial: Partial<ViewIssue> = {}): ViewIssue {
  const n = ++counter;
  return {
    id: `i${n}`, projectId: PROJECT, ref: `NEX-${n}`, title: `Issue ${n}`, detail: "",
    status: "todo", priority: "medium", parentId: null, assigneeAgentId: null,
    stateId: column("todo"), cycleId: null, moduleIds: [], labelIds: [],
    estimatePoint: null, startDate: null, targetDate: null, sequence: null,
    intakeStatus: null, createdAt: n, updatedAt: n, ...partial,
  };
}

/* ---------- resolveStateId ---------- */

test("an issue renders in the column matching its status, and blocked work waits under Todo", () => {
  assert.equal(resolveStateId(issue({ status: "backlog", stateId: column("backlog") }), states), column("backlog"));
  // `blocked` and `cancelled` have no column of their own.
  assert.equal(resolveStateId(issue({ status: "blocked", stateId: null }), states), column("todo"));
  assert.equal(resolveStateId(issue({ status: "cancelled", stateId: null }), states), column("done"));
});

test("a custom column survives only while its group still matches the status", () => {
  const review: WorkflowState = { id: "custom-qa", projectId: PROJECT, name: "QA", statusGroup: "in_review", color: "#000", position: 6, isDefault: false };
  const all = [...states, review];
  assert.equal(resolveStateId(issue({ status: "in_review", stateId: review.id }), all), review.id, "two columns may share a group");
  // The lifecycle moved the work on without knowing about columns.
  assert.equal(resolveStateId(issue({ status: "done", stateId: review.id }), all), column("done"));
});

test("with no columns at all an issue resolves to nothing rather than throwing", () => {
  assert.equal(resolveStateId(issue({ status: "todo", stateId: null }), []), null);
});

/* ---------- applyFilters ---------- */

test("an empty filter is no constraint, and each key narrows independently", () => {
  const list = [
    issue({ status: "todo", priority: "high", assigneeAgentId: "a1" }),
    issue({ status: "done", priority: "low", assigneeAgentId: "a2" }),
    issue({ status: "todo", priority: "low", assigneeAgentId: "a1" }),
  ];
  assert.equal(applyFilters(list, {}).length, 3);
  assert.equal(applyFilters(list).length, 3, "an absent filter object is the same as an empty one");
  assert.equal(applyFilters(list, { statuses: [] }).length, 3, "an empty list is not 'match nothing'");
  assert.equal(applyFilters(list, { statuses: ["todo"] }).length, 2);
  // Values inside one key are an OR; separate keys are an AND.
  assert.equal(applyFilters(list, { priorities: ["high", "low"] }).length, 3);
  assert.equal(applyFilters(list, { statuses: ["todo"], priorities: ["low"] }).length, 1);
});

test("search matches the ref, title and body, case-insensitively", () => {
  const list = [
    issue({ ref: "NEX-99", title: "Ship the billing page", detail: "" }),
    issue({ title: "Unrelated", detail: "mentions BILLING deep in the body" }),
    issue({ title: "Nothing to see" }),
  ];
  assert.equal(applyFilters(list, { search: "billing" }).length, 2);
  assert.equal(applyFilters(list, { search: "nex-99" }).length, 1);
  assert.equal(applyFilters(list, { search: "   " }).length, 3, "a blank search is not a filter");
});

test("null selects the unassigned work rather than being ignored", () => {
  const list = [issue({ assigneeAgentId: "a1" }), issue({ assigneeAgentId: null }), issue({ cycleId: "c1" })];
  assert.equal(applyFilters(list, { assigneeIds: [null] }).length, 2);
  assert.equal(applyFilters(list, { assigneeIds: ["a1", null] }).length, 3);
  assert.equal(applyFilters(list, { cycleIds: [null] }).length, 2);
});

test("a many-to-many filter matches when any one value overlaps", () => {
  const list = [issue({ labelIds: ["bug", "ui"] }), issue({ labelIds: ["chore"] }), issue({ labelIds: [] })];
  assert.equal(applyFilters(list, { labelIds: ["bug"] }).length, 1);
  assert.equal(applyFilters(list, { labelIds: ["bug", "chore"] }).length, 2);
  assert.equal(applyFilters(list, { moduleIds: ["m1"] }).length, 0);
});

test("a date bound excludes undated work instead of sweeping it in", () => {
  const list = [issue({ targetDate: 100 }), issue({ targetDate: 500 }), issue({ targetDate: null })];
  assert.deepEqual(applyFilters(list, { targetDateFrom: 200 }).map((i) => i.targetDate), [500]);
  assert.deepEqual(applyFilters(list, { targetDateTo: 200 }).map((i) => i.targetDate), [100]);
  assert.equal(applyFilters(list, { targetDateFrom: 0, targetDateTo: 1000 }).length, 2, "the undated issue is not 'due in range'");
});

/* ---------- orderIssues ---------- */

test("manual ordering follows sequence, and cards with none sink below those that have one", () => {
  const list = [issue({ sequence: null, createdAt: 1 }), issue({ sequence: 5 }), issue({ sequence: 2 })];
  assert.deepEqual(orderIssues(list, "manual").map((i) => i.sequence), [2, 5, null]);
});

test("priority ordering runs urgent to low and puts an unknown priority last", () => {
  const list = [issue({ priority: "low" }), issue({ priority: "urgent" }), issue({ priority: "wat" }), issue({ priority: "high" })];
  assert.deepEqual(orderIssues(list, "priority").map((i) => i.priority), ["urgent", "high", "low", "wat"]);
});

test("target-date ordering is ascending with undated work last", () => {
  const list = [issue({ targetDate: null }), issue({ targetDate: 300 }), issue({ targetDate: 100 })];
  assert.deepEqual(orderIssues(list, "target_date").map((i) => i.targetDate), [100, 300, null]);
});

test("ordering is total, so equal keys never depend on the order rows arrived in", () => {
  // Same priority, same timestamps — only the id tie-break separates them.
  const a = issue({ id: "aaa", priority: "high", createdAt: 5, updatedAt: 5, sequence: 1 });
  const b = issue({ id: "bbb", priority: "high", createdAt: 5, updatedAt: 5, sequence: 1 });
  for (const orderBy of ["manual", "priority", "updated", "created", "target_date"] as const) {
    assert.deepEqual(orderIssues([a, b], orderBy).map((i) => i.id), ["aaa", "bbb"], orderBy);
    assert.deepEqual(orderIssues([b, a], orderBy).map((i) => i.id), ["aaa", "bbb"], `${orderBy} reversed`);
  }
});

test("ordering does not mutate the list it was given", () => {
  const list = [issue({ sequence: 9 }), issue({ sequence: 1 })];
  const before = list.map((i) => i.id);
  orderIssues(list, "manual");
  assert.deepEqual(list.map((i) => i.id), before);
});

/* ---------- groupIssues ---------- */

test("every declared column comes back, empty ones included", () => {
  // A kanban board with a hidden In Review column is a board you cannot drop onto.
  const groups = groupIssues([issue({ status: "todo", stateId: column("todo") })], "state", { states });
  assert.deepEqual(groups.map((g) => g.label), ["Backlog", "Todo", "In Progress", "In Review", "Done"]);
  assert.equal(groups.find((g) => g.label === "Todo")!.issues.length, 1);
  assert.deepEqual(groups.filter((g) => g.label !== "Todo").flatMap((g) => g.issues), [], "the rest are present and empty");
});

test("columns come back in position order regardless of how they were loaded", () => {
  const shuffled = [states[3], states[0], states[4], states[1], states[2]];
  assert.deepEqual(groupIssues([], "state", { states: shuffled }).map((g) => g.label),
    ["Backlog", "Todo", "In Progress", "In Review", "Done"]);
});

test("grouping by state resolves the column rather than trusting a stale one", () => {
  // The lifecycle finished this work; its stored column was never updated.
  const stale = issue({ status: "done", stateId: column("todo") });
  const groups = groupIssues([stale], "state", { states });
  assert.deepEqual(groups.find((g) => g.label === "Done")!.issues.map((i) => i.id), [stale.id]);
  assert.deepEqual(groups.find((g) => g.label === "Todo")!.issues, []);
});

test("an issue with several labels appears under each of them", () => {
  const labels: Label[] = [
    { id: "bug", projectId: PROJECT, name: "bug", color: "#f00", createdAt: 1 },
    { id: "ui", projectId: PROJECT, name: "ui", color: "#00f", createdAt: 2 },
  ];
  const both = issue({ labelIds: ["bug", "ui"] });
  const groups = groupIssues([both, issue({ labelIds: [] })], "label", { labels });
  assert.deepEqual(groups.find((g) => g.key === "bug")!.issues.map((i) => i.id), [both.id]);
  assert.deepEqual(groups.find((g) => g.key === "ui")!.issues.map((i) => i.id), [both.id]);
  assert.equal(groups.find((g) => g.key === UNGROUPED)!.issues.length, 1, "unlabelled work gets its own bucket");
});

test("work with no value on the grouping axis lands in one bucket, not in limbo", () => {
  const agents = [{ id: "a1", name: "Hutao" }];
  const groups = groupIssues([issue({ assigneeAgentId: "a1" }), issue({ assigneeAgentId: null })], "assignee", { agents });
  assert.equal(groups.find((g) => g.key === "a1")!.issues.length, 1);
  assert.equal(groups.find((g) => g.key === UNGROUPED)!.label, "Unassigned");
  assert.equal(groups.find((g) => g.key === UNGROUPED)!.issues.length, 1);
});

test("a key the context never declared is appended rather than dropping the work", () => {
  // A label loaded before it was deleted, say — the card must still render.
  const orphan = issue({ labelIds: ["deleted-label"] });
  const groups = groupIssues([orphan], "label", { labels: [] });
  assert.deepEqual(groups.find((g) => g.key === "deleted-label")!.issues.map((i) => i.id), [orphan.id]);
});

test("grouping by cycle and module keeps the containers the context declares", () => {
  const cycles: Cycle[] = [{ id: "c1", projectId: PROJECT, name: "Sprint 1", description: "", startDate: 1, endDate: 2, completedAt: null, createdAt: 1, updatedAt: 1 }];
  const modules: Module[] = [{ id: "m1", projectId: PROJECT, name: "Billing", description: "", leadAgentId: null, targetDate: null, status: "backlog", completedAt: null, createdAt: 1, updatedAt: 1 }];
  assert.deepEqual(groupIssues([issue({ cycleId: "c1" })], "cycle", { cycles }).map((g) => g.label), ["Sprint 1", "No cycle"]);
  assert.deepEqual(groupIssues([issue({ moduleIds: ["m1"] })], "module", { modules }).map((g) => g.label), ["Billing", "No module"]);
});

test("grouping by nothing yields a single list", () => {
  const groups = groupIssues([issue(), issue()], "none");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].issues.length, 2);
});

/* ---------- buildView ---------- */

test("buildView filters, groups and orders in that order", () => {
  const list = [
    issue({ status: "todo", stateId: column("todo"), priority: "low", sequence: 2 }),
    issue({ status: "todo", stateId: column("todo"), priority: "urgent", sequence: 1 }),
    issue({ status: "done", stateId: column("done"), priority: "high" }),
  ];
  const view = buildView(list, { groupBy: "state", orderBy: "priority", filters: { statuses: ["todo"] } }, { states });
  assert.equal(view.total, 2, "the filter ran before anything else");
  const todo = view.groups.find((g) => g.label === "Todo")!;
  assert.deepEqual(todo.issues.map((i) => i.priority), ["urgent", "low"], "ordering applies within each column");
  assert.equal(view.groups.length, 5, "the empty columns survived the filter");
});

test("buildView fills in the defaults for whatever the caller left out", () => {
  const view = buildView([issue()], {}, { states });
  assert.deepEqual(view.config, { layout: "board", groupBy: "state", orderBy: "manual", filters: {} });
});

test("the total counts work items, not group memberships", () => {
  // One issue in two label columns is still one work item.
  const view = buildView([issue({ labelIds: ["bug", "ui"] })], { groupBy: "label" }, {});
  assert.equal(view.total, 1);
  assert.equal(view.groups.reduce((sum, g) => sum + g.issues.length, 0), 2);
});

/* ---------- nextSequence ---------- */

test("a drop between two cards lands strictly between them", () => {
  assert.equal(nextSequence(1, 2), 1.5);
  assert.ok(nextSequence(1, 1.5) > 1 && nextSequence(1, 1.5) < 1.5);
});

test("dropping at either end extends past the edge instead of colliding", () => {
  assert.equal(nextSequence(null, 5), 4, "above the top card");
  assert.equal(nextSequence(5, null), 6, "below the bottom card");
  assert.equal(nextSequence(null, null), 1, "the first card in an empty column");
});

test("repeated drops into the same gap keep producing distinct values", () => {
  // Fractional indexing halves the gap each time; 30 insertions must not
  // converge onto a neighbour, or two cards would tie.
  const low = 1;
  let high = 2;
  const seen = new Set<number>([low, high]);
  for (let i = 0; i < 30; i++) {
    const mid = nextSequence(low, high);
    assert.ok(mid > low && mid < high, `insertion ${i} stayed inside the gap`);
    assert.ok(!seen.has(mid), `insertion ${i} produced a fresh value`);
    seen.add(mid);
    high = mid;
  }
});

test("cards ordered by a sequence produced this way come back in drop order", () => {
  const a = issue({ sequence: 1 });
  const c = issue({ sequence: 2 });
  const b = issue({ sequence: nextSequence(a.sequence, c.sequence) });
  assert.deepEqual(orderIssues([c, a, b], "manual").map((i) => i.id), [a.id, b.id, c.id]);
});
