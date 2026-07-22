import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { AgentLifecycleService, type AgentConfigInput } from "../lib/agent-lifecycle";
import {
  applyRetention, configActivityDiff, deleteProjectData, DataControlError, exportProjectData,
  INTEGRITY_REQUIRED_ACTIONS, planRetention,
} from "../lib/governance";
import { activityLog, documents, projects, runEvents } from "../lib/db/schema";
import { eq } from "drizzle-orm";

// A gateway-key-shaped secret that must never survive into any governance output.
const SECRET = `sk-${"z".repeat(40)}`;
const DAY = 86_400_000;

const config = (name: string, role: "lead" | "worker", reportsTo: string | null = null): AgentConfigInput => ({
  name, role, reportsTo, title: "Engineer", scope: "Build", capabilities: ["coding"],
  adapterType: "nexotao", adapterConfig: { model: "nexotao-test", apiKey: SECRET },
  runtimeConfig: {}, permissions: { shell: false }, instructions: "Work carefully",
  projectAccess: ["p"], concurrency: 1,
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-governance-"));
  const database = await openDatabase(path.join(dir, "db.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Governance", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  return { dir, database };
}

test("planRetention is deterministic and never prunes integrity-required audit rows", () => {
  const now = 100 * DAY;
  const runEventRows = [
    { runId: "run-b", seq: 2, createdAt: now - 40 * DAY },
    { runId: "run-a", seq: 1, createdAt: now - 40 * DAY },
    { runId: "run-a", seq: 2, createdAt: now - 1 * DAY },
  ];
  const activity = [
    { id: "a3", action: "issue.assigned", createdAt: now - 40 * DAY },
    { id: "a1", action: "agent.config_updated", createdAt: now - 90 * DAY },
    { id: "a2", action: "agent.config_updated", createdAt: now - 1 * DAY },
  ];
  const policy = { runEventDays: 30, auditDays: 30 };
  const first = planRetention({ now, policy, runEvents: runEventRows, activity });
  const second = planRetention({ now, policy, runEvents: runEventRows, activity });
  assert.deepEqual(first, second, "same inputs must produce the same plan");
  // Only the two old events are pruned, sorted deterministically.
  assert.deepEqual(first.runEvents, [{ runId: "run-a", seq: 1 }, { runId: "run-b", seq: 2 }]);
  // Both old audit rows pruned (sorted by id); the recent row survives.
  assert.deepEqual(first.activity, ["a1", "a3"]);
  assert.equal(first.keptForIntegrity, 0);
  // No action currently gates another invariant, but the planner still honors
  // the integrity set so a future entry would be protected.
  assert.equal(INTEGRITY_REQUIRED_ACTIONS.size, 0);

  // A null / zero window keeps everything.
  const keepAll = planRetention({ now, policy: { runEventDays: null, auditDays: 0 }, runEvents: runEventRows, activity });
  assert.deepEqual(keepAll, { runEvents: [], activity: [], keptForIntegrity: 0 });
});

test("config-change audit records a redacted before/after summary without secrets", async () => {
  const { dir, database } = await fixture();
  try {
    const service = new AgentLifecycleService(database);
    const agent = await service.create("p", config("Builder", "lead"));
    // Change permissions and adapter config (which carries a secret).
    await service.update(agent.id, { permissions: { shell: true }, adapterConfig: { model: "nexotao-2", apiKey: SECRET } });

    const rows = database.read((db) => db.select().from(activityLog).where(eq(activityLog.entityId, agent.id)).all());
    const updated = rows.find((row) => row.action === "agent.config_updated");
    assert.ok(updated, "config update must be audited");
    const summary = updated!.summary as { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> };
    assert.ok(summary.fields.includes("permissions"), "permission changes are surfaced");
    assert.ok(summary.fields.includes("adapterConfig"), "adapter config changes are surfaced");
    // The secret must be masked everywhere in the audit summary.
    assert.ok(!JSON.stringify(summary).includes(SECRET), "no secret in the audit summary");
    assert.ok(!JSON.stringify(rows).includes(SECRET), "no secret anywhere in the activity feed");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("configActivityDiff only reports changed fields and redacts secret-shaped values", () => {
  const before = { permissions: { shell: false }, concurrency: 1, adapterConfig: { apiKey: SECRET } };
  const after = { permissions: { shell: true }, concurrency: 1, adapterConfig: { apiKey: SECRET } };
  const diff = configActivityDiff(before, after);
  assert.deepEqual(diff.fields, ["permissions"], "unchanged concurrency/adapter are omitted");
  assert.ok(!JSON.stringify(diff).includes(SECRET));
});

test("export bundles project data with every secret redacted", async () => {
  const { dir, database } = await fixture();
  try {
    const repositories = new ControlPlaneRepositories(database);
    const service = new AgentLifecycleService(database);
    const agent = await service.create("p", config("Builder", "lead"));
    await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Ship", status: "todo", assigneeAgentId: agent.id, createdAt: 3, updatedAt: 3 });
    await repositories.addComment({ issueId: "i", authorType: "user", body: `token ${SECRET} leaked in a comment` });
    await repositories.appendRunEvent({ runId: "run-1", seq: 1, type: "tool", redactedPayload: { note: "ok" }, createdAt: 5 });
    await repositories.appendActivity({ actorType: "user", actorId: null, action: "note", entityType: "issue", entityId: "i", summary: { text: `bearer ${SECRET}` } });

    const bundle = exportProjectData(database, "p") as Record<string, unknown>;
    assert.ok(bundle, "known project exports");
    assert.equal((bundle.counts as Record<string, number>).agents, 1);
    assert.equal((bundle.counts as Record<string, number>).issues, 1);
    const serialized = JSON.stringify(bundle);
    assert.ok(!serialized.includes(SECRET), "export must not contain any secret");
    assert.ok(serialized.includes("[REDACTED]"), "secret-bearing fields are redacted in place");
    assert.equal(exportProjectData(database, "missing"), null);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retention prunes redacted events and old audit rows while keeping run integrity", async () => {
  const { dir, database } = await fixture();
  try {
    const now = 100 * DAY;
    // Insert run events and audit rows with explicit timestamps — the append
    // helpers stamp their own clock, which retention keys off.
    await database.write((db) => {
      db.insert(runEvents).values({ runId: "run-1", seq: 1, type: "tool", redactedPayload: { a: 1 }, createdAt: now - 60 * DAY }).run();
      db.insert(runEvents).values({ runId: "run-1", seq: 2, type: "success", redactedPayload: { a: 2 }, createdAt: now - 1 * DAY }).run();
      db.insert(activityLog).values({ id: "old", actorType: "system", actorId: null, action: "issue.assigned", entityType: "issue", entityId: "i", summary: {}, runId: null, createdAt: now - 60 * DAY }).run();
      db.insert(activityLog).values({ id: "recent", actorType: "system", actorId: null, action: "agent.config_updated", entityType: "agent", entityId: "a", summary: {}, runId: null, createdAt: now - 1 * DAY }).run();
    });

    const outcome = await applyRetention(database, { runEventDays: 30, auditDays: 30 }, now);
    assert.equal(outcome.removedRunEvents, 1);
    assert.equal(outcome.removedActivity, 1);
    assert.equal(outcome.keptForIntegrity, 0);

    const remainingEvents = database.read((db) => db.select().from(runEvents).all());
    assert.deepEqual(remainingEvents.map((row) => row.seq), [2], "recent event survives, old one pruned");
    const remainingAudit = database.read((db) => db.select().from(activityLog).all().map((row) => row.id));
    assert.ok(remainingAudit.includes("recent"), "recent audit row survives");
    assert.ok(!remainingAudit.includes("old"), "stale ordinary audit row pruned");

    // Re-running with the same clock is a no-op — deterministic and idempotent.
    const again = await applyRetention(database, { runEventDays: 30, auditDays: 30 }, now);
    assert.equal(again.removedRunEvents, 0);
    assert.equal(again.removedActivity, 0);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete removes eligible data, reports the outcome, retains audit, and leaves no orphans", async () => {
  const { dir, database } = await fixture();
  try {
    const repositories = new ControlPlaneRepositories(database);
    const service = new AgentLifecycleService(database);
    const agent = await service.create("p", config("Builder", "lead"));
    await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Ship", status: "todo", assigneeAgentId: agent.id, createdAt: 3, updatedAt: 3 });
    const run = await repositories.createHeartbeat({ agentId: agent.id, issueId: "i", source: "assignment", status: "succeeded", startedAt: 4, finishedAt: 5 });
    await repositories.appendRunEvent({ runId: run.id, seq: 1, type: "tool", redactedPayload: { note: "ok" }, createdAt: 6 });
    await repositories.putDocument({ issueId: "i", key: "plan", body: `plan with ${SECRET}`, createdByType: "user" });
    await repositories.appendActivity({ actorType: "user", actorId: null, action: "note", entityType: "issue", entityId: "i", summary: { text: "kept" } });

    await assert.rejects(() => deleteProjectData(database, "p", { confirm: false }), (error: unknown) => error instanceof DataControlError && error.code === "confirmation_required");
    await assert.rejects(() => deleteProjectData(database, "missing", { confirm: true }), (error: unknown) => error instanceof DataControlError && error.code === "not_found");

    const outcome = await deleteProjectData(database, "p", { confirm: true });
    assert.equal(outcome.deleted.agents, 1);
    assert.equal(outcome.deleted.issues, 1);
    assert.equal(outcome.deleted.heartbeatRuns, 1);
    assert.equal(outcome.deleted.runEvents, 1);
    assert.equal(outcome.deleted.documents, 1);
    assert.equal(outcome.deleted.documentRevisions, 1);
    // Scoped audit = agent.created + the note, both retained after deletion.
    assert.equal(outcome.retained.activityLog, 2, "audit activity is retained after deletion");
    assert.ok(outcome.integrityNote.length > 0);
    assert.ok(!JSON.stringify(outcome).includes(SECRET), "deletion report carries no secret");

    // The project row and its cascade are gone; no orphaned events or documents remain.
    assert.equal(database.read((db) => db.select().from(projects).where(eq(projects.id, "p")).get()), undefined);
    assert.equal(database.read((db) => db.select().from(runEvents).all()).length, 0, "no orphaned run events");
    assert.equal(database.read((db) => db.select().from(documents).all()).length, 0, "no orphaned documents");
    // The append-only audit trail survives as the durable record.
    assert.equal(database.read((db) => db.select().from(activityLog).where(eq(activityLog.entityId, "i")).all()).length, 1);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
