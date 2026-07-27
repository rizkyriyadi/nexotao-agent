import assert from "node:assert/strict";
import test from "node:test";
import {
  describeInboxItems,
  inboxCount,
  inboxItemIds,
  kindOf,
  newlyArrived,
  selectAttentionRuns,
  unreadIds,
} from "../lib/inbox-signal";

const snapshot = {
  approvals: [{ id: "a1" }, { id: "a2" }],
  issues: [{ id: "i1" }],
  runs: [{ id: "r1" }],
};

test("a failed durable run is listed once, not as both failed and stale", () => {
  const now = 1_000_000_000;
  const old = now - 60 * 60_000;
  // The real shape of a failed durable run: the heartbeat is finalized as
  // `failed`, while its run_records twin is left at `running` and ages out.
  const runs = selectAttentionRuns({
    now,
    heartbeats: [{ id: "run-1", status: "failed", error: "fatal: a branch named 'nexotao/nx-22/x' already exists", issueId: "issue-1", startedAt: old, updatedAt: old }],
    records: [{ id: "run-1", status: "running", createdAt: old, updatedAt: old }],
  });
  assert.equal(runs.length, 1, "one run produces one row");
  assert.equal(runs[0].status, "failed", "the heartbeat's verdict wins over the record's stale age");
  assert.match(runs[0].error ?? "", /^fatal:/, "the cause is carried through for display");
  assert.equal(runs[0].href, "/board/issue-1");
});

test("a legacy record with no heartbeat twin is still surfaced", () => {
  const now = 1_000_000_000;
  const runs = selectAttentionRuns({
    now,
    heartbeats: [],
    records: [{ id: "legacy", status: "error", createdAt: now - 60 * 60_000, updatedAt: now - 60 * 60_000 }],
  });
  assert.deepEqual(runs.map((run) => [run.id, run.status]), [["legacy", "failed"]]);
});

test("healthy recent runs are not reported as needing attention", () => {
  const now = 1_000_000_000;
  const runs = selectAttentionRuns({
    now,
    heartbeats: [{ id: "ok", status: "running", error: null, issueId: null, startedAt: now - 1000, updatedAt: now - 1000 }],
    records: [{ id: "ok", status: "running", createdAt: now - 1000, updatedAt: now - 1000 }],
  });
  assert.deepEqual(runs, []);
});

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
