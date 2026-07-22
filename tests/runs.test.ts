import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRuns, activeRuns, type RunIssue } from "../lib/runs";

function issue(partial: Partial<RunIssue> & Pick<RunIssue, "id" | "status">): RunIssue {
  return {
    parentId: null,
    title: partial.id,
    updatedAt: 0,
    runId: null,
    assigneeAgentId: null,
    ...partial,
  };
}

test("groups delegated issues under their root and counts tasks", () => {
  const issues: RunIssue[] = [
    issue({ id: "root", status: "in_progress", title: "Add login" }),
    issue({ id: "c1", parentId: "root", status: "in_progress" }),
    issue({ id: "c2", parentId: "root", status: "todo" }),
  ];
  const [run] = summarizeRuns(issues);
  assert.equal(run.rootId, "root");
  assert.equal(run.title, "Add login");
  assert.equal(run.taskCount, 2);
  assert.equal(run.runningCount, 2); // lead + one delegate executing
  assert.equal(run.active, true);
});

test("live node prefers a running delegate over the root", () => {
  const issues: RunIssue[] = [
    issue({ id: "root", status: "in_progress", runId: "r0" }),
    issue({ id: "worker", parentId: "root", status: "in_progress", runId: "r1" }),
  ];
  const [run] = summarizeRuns(issues);
  assert.equal(run.liveNodeId, "worker");
  assert.equal(run.liveRunId, "r1");
});

test("live node falls back to the root when only the root runs", () => {
  const issues: RunIssue[] = [
    issue({ id: "root", status: "in_progress", runId: "r0" }),
    issue({ id: "worker", parentId: "root", status: "todo" }),
  ];
  const [run] = summarizeRuns(issues);
  assert.equal(run.liveNodeId, "root");
  assert.equal(run.liveRunId, "r0");
});

test("a finished run is not active", () => {
  const issues: RunIssue[] = [
    issue({ id: "root", status: "done" }),
    issue({ id: "c1", parentId: "root", status: "done" }),
  ];
  const [run] = summarizeRuns(issues);
  assert.equal(run.active, false);
  assert.equal(run.runningCount, 0);
  assert.equal(activeRuns(issues).length, 0);
});

test("active runs sort ahead of finished ones, newest first", () => {
  const issues: RunIssue[] = [
    issue({ id: "old-done", status: "done", updatedAt: 100 }),
    issue({ id: "fresh-run", status: "in_progress", updatedAt: 50 }),
    issue({ id: "older-run", status: "todo", updatedAt: 40 }),
  ];
  const order = summarizeRuns(issues).map((r) => r.rootId);
  assert.deepEqual(order, ["fresh-run", "older-run", "old-done"]);
});

test("updatedAt reflects the most recent activity anywhere in the run", () => {
  const issues: RunIssue[] = [
    issue({ id: "root", status: "in_progress", updatedAt: 10 }),
    issue({ id: "c1", parentId: "root", status: "in_progress", updatedAt: 99 }),
  ];
  const [run] = summarizeRuns(issues);
  assert.equal(run.updatedAt, 99);
});
