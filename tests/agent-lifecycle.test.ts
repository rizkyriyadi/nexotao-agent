import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { AgentLifecycleError, AgentLifecycleService, type AgentConfigInput } from "../lib/agent-lifecycle";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { activityLog, agentConfigRevisions, costEvents, heartbeatRuns, issues, projects } from "../lib/db/schema";

const base = (name: string, role: "lead" | "worker", reportsTo: string | null = null): AgentConfigInput => ({
  name, role, reportsTo, title: role === "lead" ? "Team lead" : "Engineer", scope: "Build the product",
  capabilities: ["coding"], adapterType: "nexotao", adapterConfig: { model: "nexotao-test" },
  runtimeConfig: {}, permissions: { shell: true }, instructions: "Work carefully", projectAccess: ["p"],
  concurrency: 2,
});

test("agent configuration, hierarchy, revisions, lifecycle, and audit are durable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-agent-lifecycle-"));
  const database = await openDatabase(path.join(dir, "db.sqlite"), { migrateJson: false });
  try {
    await database.write((db) => db.insert(projects).values({ id: "p", name: "Lifecycle", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
    const invoked: string[] = [];
    const retried: string[] = [];
    const service = new AgentLifecycleService(database, {
      invoke: async ({ issueId }) => { invoked.push(issueId); },
      cancel: async () => true,
      retry: async (runId) => { retried.push(runId); return true; },
    });
    const lead = await service.create("p", base("Lead", "lead"));
    const worker = await service.create("p", base("Builder", "worker", lead.id));
    await assert.rejects(() => service.create("p", base("Other lead", "lead")), (error: unknown) => error instanceof AgentLifecycleError && error.code === "conflict");

    await service.update(worker.id, { title: "Senior engineer", concurrency: 3 });
    let detail = service.list("p").find((agent) => agent.id === worker.id)!;
    assert.equal(detail.title, "Senior engineer");
    assert.equal(detail.concurrency, 3);
    assert.deepEqual(detail.revisions.map((revision) => revision.revision), [2, 1]);
    assert.ok(detail.activity.some((entry) => entry.action === "agent.config_updated"));

    const repositories = new ControlPlaneRepositories(database);
    await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Ship", status: "todo", assigneeAgentId: worker.id, createdAt: 4, updatedAt: 4 });
    await service.action(worker.id, "invoke");
    assert.deepEqual(invoked, ["i"]);
    assert.equal(service.get(worker.id).status, "queued");
    await service.action(worker.id, "pause");
    assert.equal(service.get(worker.id).status, "paused");
    await service.action(worker.id, "resume");
    assert.equal(service.get(worker.id).status, "idle");

    const failed = await repositories.createHeartbeat({ agentId: worker.id, issueId: "i", source: "invoke", status: "failed", error: "gateway", startedAt: 5, finishedAt: 6 });
    await service.markError(worker.id, "gateway");
    await service.action(worker.id, "retry_last_task");
    assert.deepEqual(retried, [failed.id]);
    assert.equal(service.get(worker.id).status, "queued");

    await assert.rejects(() => service.action(worker.id, "terminate"), (error: unknown) => error instanceof AgentLifecycleError && error.code === "confirmation_required");
    await service.action(worker.id, "terminate", { confirmed: true });
    assert.equal(service.get(worker.id).status, "terminated");
    await service.action(lead.id, "terminate", { confirmed: true });
    assert.equal(service.get(lead.id).status, "terminated");

    detail = service.list("p").find((agent) => agent.id === worker.id)!;
    assert.ok(detail.activity.some((entry) => entry.action === "agent.terminate"));
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting an agent removes the row, cascades its history, detaches issues, and keeps an audit trail", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-agent-delete-"));
  const database = await openDatabase(path.join(dir, "db.sqlite"), { migrateJson: false });
  try {
    await database.write((db) => db.insert(projects).values({ id: "p", name: "Delete", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
    const cancelled: string[] = [];
    const service = new AgentLifecycleService(database, {
      invoke: async () => {}, cancel: async (runId) => { cancelled.push(runId); return true; }, retry: async () => true,
    });
    const lead = await service.create("p", base("Lead", "lead"));
    const worker = await service.create("p", base("Builder", "worker", lead.id));

    // Delete needs confirmation.
    await assert.rejects(() => service.delete(worker.id), (e: unknown) => e instanceof AgentLifecycleError && e.code === "confirmation_required");

    // A lead with an active specialist cannot be deleted first.
    await assert.rejects(() => service.delete(lead.id, { confirmed: true }), (e: unknown) => e instanceof AgentLifecycleError && e.code === "conflict");

    // Seed dependent rows: an assigned issue, a running heartbeat, and a cost event.
    const repositories = new ControlPlaneRepositories(database);
    await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Ship", status: "todo", assigneeAgentId: worker.id, createdAt: 4, updatedAt: 4 });
    const run = await repositories.createHeartbeat({ agentId: worker.id, issueId: "i", source: "invoke", status: "running", startedAt: 5 });
    await database.write((db) => db.insert(costEvents).values({ id: "c", runId: run.id, agentId: worker.id, model: "m", inputTokens: 1, outputTokens: 1, cost: 0.01, createdAt: 6 }).run());

    const result = await service.delete(worker.id, { confirmed: true });
    assert.deepEqual(result, { id: worker.id, deleted: true });
    assert.deepEqual(cancelled, [run.id], "the in-flight run was cancelled");

    // The agent and all FK-cascaded rows are gone.
    assert.throws(() => service.get(worker.id), (e: unknown) => e instanceof AgentLifecycleError && e.code === "not_found");
    assert.equal(database.read((db) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, worker.id)).all()).length, 0);
    assert.equal(database.read((db) => db.select().from(costEvents).where(eq(costEvents.agentId, worker.id)).all()).length, 0);
    assert.equal(database.read((db) => db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, worker.id)).all()).length, 0);

    // The issue is detached rather than deleted.
    const issue = database.read((db) => db.select().from(issues).where(eq(issues.id, "i")).get());
    assert.ok(issue && issue.assigneeAgentId === null, "issue survives with assignee cleared");

    // The audit trail survives the delete.
    const audit = database.read((db) => db.select().from(activityLog).where(and(eq(activityLog.entityId, worker.id), eq(activityLog.action, "agent.deleted"))).all());
    assert.equal(audit.length, 1, "a final agent.deleted audit entry remains");

    // With the specialist gone, the lead can now be deleted.
    await service.delete(lead.id, { confirmed: true });
    assert.throws(() => service.get(lead.id), (e: unknown) => e instanceof AgentLifecycleError && e.code === "not_found");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
