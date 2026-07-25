import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type AppDatabase } from "../lib/db/database";
import { agents, projects } from "../lib/db/schema";
import { IssueLifecycleService } from "../lib/issue-lifecycle";
import {
  computeBlockerAttention, describeBlockedAttention, isBlockerResolved,
  type AttentionIssue, type BlockerAttentionSnapshot,
} from "../lib/blocker-attention";

// ---------------------------------------------------------------------------
// Layer 1/2: pure attention model
// ---------------------------------------------------------------------------

let seq = 0;
function issue(partial: Partial<AttentionIssue> & { id: string }): AttentionIssue {
  return {
    identifier: `NX-${partial.id}`, title: `Task ${partial.id}`, status: "todo",
    assigneeAgentId: "agent-a", blockedBy: [], updatedAt: ++seq, ...partial,
  };
}

function snapshot(issues: AttentionIssue[], overrides: Partial<BlockerAttentionSnapshot> = {}): BlockerAttentionSnapshot {
  return { issues, agents: [{ id: "agent-a", name: "Agent A", status: "idle" }], ...overrides };
}

test("a blocker chain with live work is covered, not an alert", () => {
  const snap = snapshot([
    issue({ id: "root", status: "blocked", blockedBy: ["b1", "b2"] }),
    issue({ id: "b1", status: "done" }),
    issue({ id: "b2", status: "in_progress" }),
  ]);
  const attention = computeBlockerAttention("root", snap);
  assert.equal(attention.state, "covered");
  assert.equal(attention.resolvedCount, 1);
  assert.equal(attention.totalCount, 2);
  assert.equal(attention.deadLeaves.length, 0);

  const described = describeBlockedAttention(attention, snap);
  assert.equal(described.severity, "info");
  assert.equal(described.action.label, "Wait");
});

test("liveness is inherited transitively — a dead leaf poisons a live-looking chain", () => {
  const snap = snapshot([
    issue({ id: "root", status: "blocked", blockedBy: ["mid"] }),
    // `mid` is blocked, so it supplies no liveness of its own.
    issue({ id: "mid", status: "blocked", blockedBy: ["leaf"] }),
    issue({ id: "leaf", status: "backlog", assigneeAgentId: null }),
  ]);
  const attention = computeBlockerAttention("root", snap);
  assert.equal(attention.state, "needs_attention");
  assert.equal(attention.steps.length, 2);
  assert.equal(attention.deadLeaves.some((step) => step.issueId === "leaf"), true);
});

test("a cancelled blocker frees the dependent but is flagged for a decision", () => {
  const snap = snapshot([
    issue({ id: "root", status: "blocked", blockedBy: ["gone"] }),
    issue({ id: "gone", status: "cancelled" }),
  ]);
  const attention = computeBlockerAttention("root", snap);
  assert.equal(attention.state, "needs_attention");
  assert.equal(attention.reason, "blocked_by_cancelled");

  const described = describeBlockedAttention(attention, snap);
  assert.equal(described.severity, "warning");
  assert.match(described.action.detail, /cancelled/);
  assert.match(described.action.detail, /Nothing will resume this/);
});

test("blocked with zero blocker edges is immediately actionable — a comment is not a blocker", () => {
  const attention = computeBlockerAttention("root", snapshot([issue({ id: "root", status: "blocked" })]));
  assert.equal(attention.state, "needs_attention");
  assert.equal(attention.reason, "blocked_without_blockers");
});

test("a blocker owned by a paused agent needs attention, not patience", () => {
  const snap = snapshot(
    [issue({ id: "root", status: "blocked", blockedBy: ["b1"] }), issue({ id: "b1", status: "todo", assigneeAgentId: "agent-z" })],
    { agents: [{ id: "agent-z", name: "Agent Z", status: "paused" }] },
  );
  const attention = computeBlockerAttention("root", snap);
  assert.equal(attention.state, "needs_attention");
  assert.equal(attention.reason, "blocker_uninvokable");
  assert.match(describeBlockedAttention(attention, snap).action.detail, /paused/);
});

test("a queued wakeup counts as liveness even while the task sits in todo", () => {
  const issues = [
    issue({ id: "root", status: "blocked", blockedBy: ["b1"] }),
    issue({ id: "b1", status: "backlog", assigneeAgentId: null }),
  ];
  assert.equal(computeBlockerAttention("root", snapshot(issues)).state, "needs_attention");
  const withWake = snapshot(issues, { wakeups: [{ issueId: "b1", status: "queued" }] });
  assert.equal(computeBlockerAttention("root", withWake).state, "covered");
});

test("a review nobody is waiting on reads as stalled rather than neglected", () => {
  const snap = snapshot([
    issue({ id: "root", status: "blocked", blockedBy: ["b1"] }),
    issue({ id: "b1", status: "in_review", assigneeAgentId: null }),
  ]);
  const attention = computeBlockerAttention("root", snap);
  assert.equal(attention.state, "stalled");
  assert.equal(attention.reason, "blocker_review_stalled");
});

test("an unresolved task with no blockers has no attention state at all", () => {
  assert.equal(computeBlockerAttention("root", snapshot([issue({ id: "root", status: "todo" })])).state, "none");
});

test("traversal terminates on a cyclic graph instead of hanging the render", () => {
  // setDependencies rejects cycles, but a corrupted or hand-edited row must not
  // be able to spin a page render forever.
  const attention = computeBlockerAttention("a", snapshot([
    issue({ id: "a", status: "blocked", blockedBy: ["b"] }),
    issue({ id: "b", status: "blocked", blockedBy: ["a"] }),
  ]));
  assert.ok(attention.steps.length <= 2);
});

// ---------------------------------------------------------------------------
// Lifecycle: the deadlocks the attention model exists to prevent
// ---------------------------------------------------------------------------

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-blocker-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => {
    db.insert(projects).values({ id: "project", name: "Project", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run();
    db.insert(agents).values([
      { id: "agent-a", projectId: "project", name: "Agent A", role: "worker", scope: "A", createdAt: 2, updatedAt: 2 },
    ]).run();
  });
  return { dir, database, lifecycle: new IssueLifecycleService(database) };
}

async function cleanup(dir: string, database: AppDatabase) {
  await database.close();
  await rm(dir, { recursive: true, force: true });
}

test("cancelling a blocker releases its dependents instead of deadlocking them", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const blocker = await lifecycle.create({ projectId: "project", title: "Blocker", assigneeAgentId: "agent-a", now: 10 });
    const dependent = await lifecycle.create({
      projectId: "project", title: "Dependent", assigneeAgentId: "agent-a", blockerIds: [blocker.id], now: 11,
    });
    assert.equal(dependent.status, "blocked");

    await lifecycle.transition(blocker.id, "cancelled", { type: "user", id: "user" }, 12);

    // Before this fix the dependent stayed `blocked` forever: wakeDependents only
    // fired on `done`, and blocked → todo was rejected while blockers were unmet.
    const after = database.read((db) => db.select().from(issuesTable).where(eqId(dependent.id)).get());
    assert.equal(after?.status, "todo");
  } finally { await cleanup(dir, database); }
});

test("a task parked in backlog with unmet blockers is derived as blocked", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const blocker = await lifecycle.create({ projectId: "project", title: "Blocker", assigneeAgentId: "agent-a", now: 10 });
    const parked = await lifecycle.create({
      projectId: "project", title: "Parked", status: "backlog", assigneeAgentId: "agent-a", blockerIds: [blocker.id], now: 11,
    });
    assert.equal(parked.status, "blocked");
  } finally { await cleanup(dir, database); }
});

test("a done blocker and a cancelled blocker both count as resolved", () => {
  assert.equal(isBlockerResolved("done"), true);
  assert.equal(isBlockerResolved("cancelled"), true);
  assert.equal(isBlockerResolved("in_review"), false);
  assert.equal(isBlockerResolved("backlog"), false);
});

// Imported late so the pure-model tests above stay free of drizzle plumbing.
import { issues as issuesTable } from "../lib/db/schema";
import { eq } from "drizzle-orm";
const eqId = (id: string) => eq(issuesTable.id, id);
