import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase, type AppDatabase } from "../lib/db/database";
import { activityLog, agents, heartbeatRuns, issues as issuesTable, projects, wakeupRequests } from "../lib/db/schema";
import { IssueDomainError, IssueLifecycleService } from "../lib/issue-lifecycle";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-issue-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => {
    db.insert(projects).values({ id: "project", name: "Project", path: dir, createdAt: 1 }).run();
    db.insert(agents).values([
      { id: "agent-a", projectId: "project", name: "Agent A", role: "lead", scope: "A", createdAt: 2, updatedAt: 2 },
      { id: "agent-b", projectId: "project", name: "Agent B", role: "lead", scope: "B", createdAt: 3, updatedAt: 3 },
    ]).run();
  });
  return { dir, database, lifecycle: new IssueLifecycleService(database) };
}

async function cleanup(dir: string, database: AppDatabase) {
  await database.close();
  await rm(dir, { recursive: true, force: true });
}

test("validated lifecycle permits only the assigned agent to check out work", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const issue = await lifecycle.create({ projectId: "project", title: "Lifecycle", assigneeAgentId: "agent-a", now: 10 });
    await assert.rejects(lifecycle.checkout(issue.id, "agent-b", "wrong-run", 20), (error: unknown) =>
      error instanceof IssueDomainError && error.code === "forbidden");
    const checkedOut = await lifecycle.checkout(issue.id, "agent-a", "run-a", 21);
    assert.equal(checkedOut.status, "in_progress");
    const done = await lifecycle.transition(issue.id, "done", { type: "agent", id: "agent-a", runId: "run-a" }, 22);
    assert.equal(done.status, "done");
    await assert.rejects(lifecycle.transition(issue.id, "todo", { type: "user" }, 23), (error: unknown) =>
      error instanceof IssueDomainError && error.code === "invalid_transition");
  } finally { await cleanup(dir, database); }
});

test("two parallel checkouts cannot obtain the same issue", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const issue = await lifecycle.create({ projectId: "project", title: "Atomic", assigneeAgentId: "agent-a", now: 10 });
    const results = await Promise.allSettled([
      lifecycle.checkout(issue.id, "agent-a", "run-1", 20),
      lifecycle.checkout(issue.id, "agent-a", "run-2", 20),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  } finally { await cleanup(dir, database); }
});

test("the final blocker queues exactly one durable eligible wakeup", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const first = await lifecycle.create({ projectId: "project", title: "First blocker", assigneeAgentId: "agent-a", now: 10 });
    const second = await lifecycle.create({ projectId: "project", title: "Second blocker", assigneeAgentId: "agent-a", now: 11 });
    const dependent = await lifecycle.create({
      projectId: "project", title: "Dependent", assigneeAgentId: "agent-b", blockerIds: [first.id, second.id], now: 12,
    });
    assert.equal(dependent.status, "blocked");
    await assert.rejects(lifecycle.checkout(dependent.id, "agent-b", "early", 13));

    await lifecycle.checkout(first.id, "agent-a", "first-run", 20);
    await lifecycle.transition(first.id, "done", { type: "agent", id: "agent-a", runId: "first-run" }, 21);
    assert.equal(database.read((db) => db.select().from(wakeupRequests).all()).filter((row) => row.issueId === dependent.id).length, 0);

    await lifecycle.checkout(second.id, "agent-a", "second-run", 30);
    await lifecycle.transition(second.id, "done", { type: "agent", id: "agent-a", runId: "second-run" }, 31);
    await lifecycle.transition(second.id, "done", { type: "agent", id: "agent-a", runId: "second-run" }, 31);
    const wakeups = database.read((db) => db.select().from(wakeupRequests).all()).filter((row) => row.issueId === dependent.id);
    assert.equal(wakeups.length, 1);
    assert.equal(wakeups[0].issueId, dependent.id);
    assert.equal(wakeups[0].reason, "dependency");
    assert.equal(database.read((db) => db.select().from(heartbeatRuns).all()).filter((row) => row.issueId === dependent.id).length, 1);
  } finally { await cleanup(dir, database); }
});

test("a retried create returns the issue the first attempt made", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const first = await lifecycle.create({ projectId: "project", title: "Root", idempotencyKey: "root-request", now: 10 });
    const retried = await lifecycle.create({ projectId: "project", title: "Root", idempotencyKey: "root-request", now: 20 });
    assert.equal(retried.id, first.id);
    await assert.rejects(
      lifecycle.create({ projectId: "project", title: "Different", idempotencyKey: "root-request", now: 30 }),
      (error: unknown) => error instanceof IssueDomainError && error.code === "conflict",
    );
    const child = await lifecycle.create({ projectId: "project", parentId: first.id, title: "Child", idempotencyKey: "sub-1", now: 40 });
    const childRetry = await lifecycle.create({ projectId: "project", parentId: first.id, title: "Child", idempotencyKey: "sub-1", now: 50 });
    assert.equal(childRetry.id, child.id);
  } finally { await cleanup(dir, database); }
});

/* ── the statuses nothing outside the engine may write ───────────────────────
 * Salvaged from the deleted work-board suite, where these were phrased as drag
 * gestures. The rule is not about dragging: `in_progress` means a run holds the
 * checkout lock, so anything that sets it without taking that lock leaves the
 * board claiming work is running while no run exists. Stated here, next to the
 * transition table it constrains. */

test("in_progress is reachable only through checkout, never through a transition", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    // Every status a caller could be sitting in, cast past the signature that
    // already excludes `in_progress` — the type keeps honest callers out, and
    // this keeps the runtime table from quietly growing an edge that lets a
    // dishonest one in.
    for (const from of ["backlog", "todo", "in_review", "blocked"] as const) {
      const issue = await lifecycle.create({ projectId: "project", title: `From ${from}`, status: from === "blocked" ? "backlog" : from, now: 10 });
      await assert.rejects(
        lifecycle.transition(issue.id, "in_progress" as never, { type: "user" }, 20),
        (error: unknown) => error instanceof IssueDomainError && error.code === "invalid_transition",
        `${from} must not have an edge to in_progress`,
      );
    }
    // Checkout is the one door, and it does set the status.
    const runnable = await lifecycle.create({ projectId: "project", title: "Real start", status: "todo", assigneeAgentId: "agent-a", now: 30 });
    assert.equal((await lifecycle.checkout(runnable.id, "agent-a", "run-1", 31)).status, "in_progress");
  } finally { await cleanup(dir, database); }
});

test("skipping the queue is refused: backlog work cannot jump straight to done", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    // `backlog → done` is not in the transition table: work has to be picked up
    // before it can be finished.
    const issue = await lifecycle.create({ projectId: "project", title: "Skip ahead", status: "backlog", now: 10 });
    await assert.rejects(
      lifecycle.transition(issue.id, "done", { type: "user" }, 20),
      (error: unknown) => error instanceof IssueDomainError && error.code === "invalid_transition",
    );
    assert.equal(database.read((db) => db.select().from(issuesTable).where(eq(issuesTable.id, issue.id)).get())?.status, "backlog");
  } finally { await cleanup(dir, database); }
});

test("blocked work cannot be talked into todo while its blockers are unmet", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const blocker = await lifecycle.create({ projectId: "project", title: "Blocker", status: "todo", now: 10 });
    const dependent = await lifecycle.create({
      projectId: "project", title: "Dependent", status: "backlog", blockerIds: [blocker.id], now: 11,
    });
    assert.equal(dependent.status, "blocked", "an unmet blocker makes the lifecycle park the issue");
    await assert.rejects(lifecycle.transition(dependent.id, "todo", { type: "user" }, 20));
    assert.equal(database.read((db) => db.select().from(issuesTable).where(eq(issuesTable.id, dependent.id)).get())?.status, "blocked",
      "nothing outside the scheduler may start blocked work");
  } finally { await cleanup(dir, database); }
});

/* ── one edit, one transaction ───────────────────────────────────────────────
 * A single user action — rename this, move it there, assign it to them — used
 * to be four separate writes. Whatever the lifecycle refused, everything before
 * it in that sequence had already committed, so the user got an error message
 * about one field and a silent change to the others. */

test("an edit the lifecycle refuses changes nothing at all", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const issue = await lifecycle.create({ projectId: "project", title: "Original", status: "backlog", now: 10 });

    // `backlog → done` is not an edge. The rename rides along with it and must
    // go down with it.
    await assert.rejects(
      lifecycle.edit({ issueId: issue.id, fields: { title: "Renamed" }, status: "done", actor: { type: "user" }, now: 20 }),
      (error: unknown) => error instanceof IssueDomainError && error.code === "invalid_transition",
    );
    const after = database.read((db) => db.select().from(issuesTable).where(eq(issuesTable.id, issue.id)).get())!;
    assert.equal(after.title, "Original", "the rename must not survive the rejected status change");
    assert.equal(after.status, "backlog");

    // And an edit that is legal all the way through lands whole.
    const edited = await lifecycle.edit({
      issueId: issue.id, fields: { title: "Renamed", priority: "high" },
      assigneeAgentId: "agent-a", status: "todo", actor: { type: "user" }, now: 30,
    });
    assert.equal(edited.title, "Renamed");
    assert.equal(edited.priority, "high");
    assert.equal(edited.assigneeAgentId, "agent-a");
    assert.equal(edited.status, "todo");
  } finally { await cleanup(dir, database); }
});

test("a status set alongside the blockers that contradict it defers to the blockers", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const blocker = await lifecycle.create({ projectId: "project", title: "Blocker", status: "todo", now: 10 });
    const issue = await lifecycle.create({ projectId: "project", title: "Work", status: "backlog", assigneeAgentId: "agent-a", now: 11 });

    // Asking for `todo` while adding an unmet blocker in the same edit. Applied
    // in sequence the blocker wins and parks it — the point is that the status
    // check sees the blocker this edit is adding, not the empty set it started
    // with, so the edit is accepted rather than throwing on a stale read.
    const edited = await lifecycle.edit({
      issueId: issue.id, blockerIds: [blocker.id], status: "todo", actor: { type: "user" }, now: 20,
    });
    assert.equal(edited.status, "blocked");
    assert.equal(
      database.read((db) => db.select().from(wakeupRequests).all()).length, 0,
      "and nothing was queued to run work that cannot run",
    );
  } finally { await cleanup(dir, database); }
});

test("an issue cannot be re-parented under its own descendant", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const parent = await lifecycle.create({ projectId: "project", title: "Epic", status: "backlog", now: 10 });
    const child = await lifecycle.create({ projectId: "project", title: "Sub", parentId: parent.id, status: "backlog", now: 11 });

    // Nothing validated a re-parent, so this was accepted — and every walk up
    // the tree afterwards ran until it ran out of stack.
    await assert.rejects(
      lifecycle.edit({ issueId: parent.id, fields: { parentId: child.id }, actor: { type: "user" }, now: 20 }),
      (error: unknown) => error instanceof IssueDomainError && error.code === "validation",
    );
    await assert.rejects(
      lifecycle.edit({ issueId: parent.id, fields: { parentId: parent.id }, actor: { type: "user" }, now: 21 }),
      (error: unknown) => error instanceof IssueDomainError && error.code === "validation",
    );
    await assert.rejects(
      lifecycle.edit({ issueId: child.id, fields: { parentId: "no-such-issue" }, actor: { type: "user" }, now: 22 }),
      (error: unknown) => error instanceof IssueDomainError && error.code === "not_found",
    );
    assert.equal(database.read((db) => db.select().from(issuesTable).where(eq(issuesTable.id, parent.id)).get())?.parentId, null);

    // Moving a task to a genuine parent is still ordinary work.
    const sibling = await lifecycle.create({ projectId: "project", title: "Other epic", status: "backlog", now: 30 });
    assert.equal((await lifecycle.edit({ issueId: child.id, fields: { parentId: sibling.id }, actor: { type: "user" }, now: 31 })).parentId, sibling.id);
  } finally { await cleanup(dir, database); }
});

/* ── reopening ───────────────────────────────────────────────────────────────
 * A follow-up message on a finished task is the one thing allowed to move work
 * out of a terminal status, and it goes through its own table for that reason.
 * `reopen` used to write the row directly, so the transition table said `done`
 * was final while the code next to it disagreed — and the disagreement was
 * invisible until something reopened from a status that had already given up
 * its checkout. */

test("reopening a finished task clears the traces of it having finished", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const issue = await lifecycle.create({ projectId: "project", title: "Ship it", status: "todo", assigneeAgentId: "agent-a", now: 10 });
    await lifecycle.checkout(issue.id, "agent-a", "run-1", 11);
    await lifecycle.transition(issue.id, "done", { type: "agent", id: "agent-a", runId: "run-1" }, 12);

    const reopened = await lifecycle.reopen(issue.id, { type: "user" }, "plan", 20);
    assert.equal(reopened.status, "todo");
    assert.equal(reopened.runMode, "plan", "the follow-up can change how the next run answers");
    // A task that is runnable again but still stamped with the day it finished
    // reads as done to everything that sorts or filters on completion.
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.checkoutRunId, null);
    assert.ok(database.read((db) => db.select().from(activityLog).all()).some((row) => row.action === "issue.reopened"));

    // Cancelled work comes back the same way — the user changed their mind.
    const dropped = await lifecycle.create({ projectId: "project", title: "Never mind", status: "todo", now: 30 });
    await lifecycle.transition(dropped.id, "cancelled", { type: "user" }, 31);
    const revived = await lifecycle.reopen(dropped.id, { type: "user" }, undefined, 32);
    assert.equal(revived.status, "todo");
    assert.equal(revived.cancelledAt, null);
  } finally { await cleanup(dir, database); }
});

test("reopening a live task carries the follow-up rather than restarting it", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const issue = await lifecycle.create({ projectId: "project", title: "Mid-flight", status: "todo", assigneeAgentId: "agent-a", now: 10 });
    await lifecycle.checkout(issue.id, "agent-a", "run-1", 11);

    const reopened = await lifecycle.reopen(issue.id, { type: "user" }, "ask", 20);
    assert.equal(reopened.status, "in_progress", "the run keeps going");
    assert.equal(reopened.checkoutRunId, "run-1", "and keeps its checkout — clearing it would let a second run start on top of the live one");
    assert.equal(reopened.runMode, "ask");
  } finally { await cleanup(dir, database); }
});

test("a reopened task with unmet blockers goes back to blocked, not to runnable", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const blocker = await lifecycle.create({ projectId: "project", title: "Blocker", status: "todo", now: 10 });
    const dependent = await lifecycle.create({ projectId: "project", title: "Dependent", status: "todo", now: 11 });
    await lifecycle.transition(dependent.id, "cancelled", { type: "user" }, 12);
    await lifecycle.setDependencies(dependent.id, [blocker.id], { type: "user" }, 13);

    const reopened = await lifecycle.reopen(dependent.id, { type: "user" }, undefined, 20);
    assert.equal(reopened.status, "blocked", "reopening must not smuggle work past its blockers");
    assert.equal(
      database.read((db) => db.select().from(wakeupRequests).all()).length, 0,
      "and nothing is queued to run it",
    );
  } finally { await cleanup(dir, database); }
});

test("recovery is deterministic, idempotent, and audited with other lock mutations", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const issue = await lifecycle.create({ projectId: "project", title: "Recover", now: 10 });
    await lifecycle.assign(issue.id, "agent-a", { type: "user", id: "user" }, 11);
    await lifecycle.checkout(issue.id, "agent-a", "release-run", 20);
    await lifecycle.release({ issueId: issue.id, agentId: "agent-a", runId: "release-run", now: 21 });
    await lifecycle.checkout(issue.id, "agent-a", "stale-run", 30);

    assert.equal((await lifecycle.recover({ now: 100, staleAfterMs: 50, activeRunIds: ["stale-run"] })).length, 0);
    const recovered = await lifecycle.recover({ now: 100, staleAfterMs: 50, activeRunIds: [] });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "todo");
    assert.equal((await lifecycle.recover({ now: 101, staleAfterMs: 50 })).length, 0);

    const actions = database.read((db) => db.select().from(activityLog).all());
    assert.ok(actions.some((row) => row.action === "issue.assigned"));
    assert.ok(actions.some((row) => row.action === "issue.checked_out"));
    assert.ok(actions.some((row) => row.action === "issue.released"));
    assert.ok(actions.some((row) => row.action === "issue.recovered"));
    assert.equal(database.read((db) => db.select().from(wakeupRequests).all()).filter((row) => row.reason === "retry").length, 1);
  } finally { await cleanup(dir, database); }
});
