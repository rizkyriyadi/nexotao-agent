import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentLifecycleError, AgentLifecycleService, type AgentConfigInput } from "../lib/agent-lifecycle";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";

const base = (name: string, role: "lead" | "worker", reportsTo: string | null = null): AgentConfigInput => ({
  name, role, reportsTo, title: role === "lead" ? "Team lead" : "Engineer", scope: "Build the product",
  capabilities: ["coding"], adapterType: "nexotao", adapterConfig: { model: "nexotao-test" },
  runtimeConfig: {}, permissions: { shell: true }, instructions: "Work carefully", projectAccess: ["p"],
  concurrency: 2, budgetLimit: 10,
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
