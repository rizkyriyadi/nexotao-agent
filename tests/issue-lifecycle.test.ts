import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type AppDatabase } from "../lib/db/database";
import { activityLog, agents, heartbeatRuns, projects, wakeupRequests } from "../lib/db/schema";
import { IssueDomainError, IssueLifecycleService } from "../lib/issue-lifecycle";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-issue-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => {
    db.insert(projects).values({ id: "project", name: "Project", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run();
    db.insert(agents).values([
      { id: "agent-a", projectId: "project", name: "Agent A", role: "worker", scope: "A", createdAt: 2, updatedAt: 2 },
      { id: "agent-b", projectId: "project", name: "Agent B", role: "worker", scope: "B", createdAt: 3, updatedAt: 3 },
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

test("create and delegate requests are idempotent", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const first = await lifecycle.create({ projectId: "project", title: "Root", idempotencyKey: "root-request", now: 10 });
    const retried = await lifecycle.create({ projectId: "project", title: "Root", idempotencyKey: "root-request", now: 20 });
    assert.equal(retried.id, first.id);
    await assert.rejects(
      lifecycle.create({ projectId: "project", title: "Different", idempotencyKey: "root-request", now: 30 }),
      (error: unknown) => error instanceof IssueDomainError && error.code === "conflict",
    );
    const child = await lifecycle.create({ projectId: "project", parentId: first.id, title: "Child", idempotencyKey: "delegate-1", now: 40 });
    const childRetry = await lifecycle.create({ projectId: "project", parentId: first.id, title: "Child", idempotencyKey: "delegate-1", now: 50 });
    assert.equal(childRetry.id, child.id);
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
