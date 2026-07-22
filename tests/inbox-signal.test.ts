import assert from "node:assert/strict";
import test from "node:test";
import {
  describeInboxItems,
  inboxCount,
  inboxItemIds,
  kindOf,
  newlyArrived,
  unreadIds,
} from "../lib/inbox-signal";

const snapshot = {
  approvals: [{ id: "a1" }, { id: "a2" }],
  issues: [{ id: "i1" }],
  runs: [{ id: "r1" }],
};

test("item ids are namespaced by section and counted across all sections", () => {
  assert.deepEqual(inboxItemIds(snapshot), ["approval:a1", "approval:a2", "issue:i1", "run:r1"]);
  assert.equal(inboxCount(snapshot), 4);
  assert.equal(inboxCount({}), 0);
});

test("namespacing prevents id collisions between sections", () => {
  const ids = inboxItemIds({ approvals: [{ id: "x" }], issues: [{ id: "x" }] });
  assert.deepEqual(ids, ["approval:x", "issue:x"]);
  assert.equal(new Set(ids).size, 2);
});

test("unreadIds returns only items not yet acknowledged", () => {
  const ids = inboxItemIds(snapshot);
  assert.deepEqual(unreadIds(ids, ["approval:a1"]), ["approval:a2", "issue:i1", "run:r1"]);
  assert.deepEqual(unreadIds(ids, new Set(ids)), []);
});

test("newlyArrived reports items absent on the previous poll", () => {
  assert.deepEqual(newlyArrived(["approval:a1", "approval:a2"], ["approval:a1"]), ["approval:a2"]);
  assert.deepEqual(newlyArrived(["approval:a1"], ["approval:a1"]), []);
  assert.deepEqual(newlyArrived(["issue:i1"], []), ["issue:i1"]);
});

test("kindOf recognizes known sections and rejects unknown", () => {
  assert.equal(kindOf("approval:a1"), "approval");
  assert.equal(kindOf("run:r1"), "run");
  assert.equal(kindOf("budget:b1"), null);
  assert.equal(kindOf("mystery:z"), null);
});

test("describeInboxItems produces a compact pluralized summary in section order", () => {
  assert.equal(
    describeInboxItems(["approval:a1", "approval:a2", "issue:i1"]),
    "2 approvals · 1 task",
  );
  assert.equal(describeInboxItems(["run:r1"]), "1 run needs attention");
  assert.equal(describeInboxItems([]), "");
});
