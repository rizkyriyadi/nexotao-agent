import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import {
  applyRetention, configActivityDiff, deleteProjectData, DataControlError, exportProjectData,
  INTEGRITY_REQUIRED_ACTIONS, planRetention,
} from "../lib/governance";
import { activityLog, documents, projects, runEvents } from "../lib/db/schema";
import { eq } from "drizzle-orm";

// A gateway-key-shaped secret that must never survive into any governance output.
const SECRET = `sk-${"z".repeat(40)}`;
const DAY = 86_400_000;

/** An agent row carrying a secret in its adapter config — the shape governance
 *  has to redact on the way out. */
const agentRow = (id: string) => ({
  id, projectId: "p", name: "Builder", role: "lead" as const, scope: "Build",
  adapterType: "nexotao", adapterConfig: { model: "nexotao-test", apiKey: SECRET },
  instructions: "Work carefully", createdAt: 2, updatedAt: 2,
});

/** Artifact purge that touches nothing: no graph directory, no CLI spawn. */
const quiet = { graphDir: () => path.join(tmpdir(), "nexotao-absent-graph-dir"), dropCodeIndex: async () => false };

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-governance-"));
  const database = await openDatabase(path.join(dir, "db.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Governance", path: dir, mode: "single", agentSpecs: [], createdAt: 1 }).run());
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
    const agent = await repositories.agents.insert(agentRow("a"));
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
    const agent = await repositories.agents.insert(agentRow("a"));
    await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Ship", status: "todo", assigneeAgentId: agent.id, createdAt: 3, updatedAt: 3 });
    const run = await repositories.createHeartbeat({ agentId: agent.id, issueId: "i", source: "assignment", status: "succeeded", startedAt: 4, finishedAt: 5 });
    await repositories.appendRunEvent({ runId: run.id, seq: 1, type: "tool", redactedPayload: { note: "ok" }, createdAt: 6 });
    await repositories.putDocument({ issueId: "i", key: "plan", body: `plan with ${SECRET}`, createdByType: "user" });
    await repositories.appendActivity({ actorType: "user", actorId: null, action: "note", entityType: "issue", entityId: "i", summary: { text: "kept" } });

    await assert.rejects(() => deleteProjectData(database, "p", { confirm: false, purge: quiet }), (error: unknown) => error instanceof DataControlError && error.code === "confirmation_required");
    await assert.rejects(() => deleteProjectData(database, "missing", { confirm: true, purge: quiet }), (error: unknown) => error instanceof DataControlError && error.code === "not_found");

    // No real CLI spawn and no real ~/.nexotao writes: the artifact purge has
    // its own test below.
    const outcome = await deleteProjectData(database, "p", { confirm: true, purge: quiet });
    assert.equal(outcome.deleted.agents, 1);
    assert.equal(outcome.deleted.issues, 1);
    assert.equal(outcome.deleted.heartbeatRuns, 1);
    assert.equal(outcome.deleted.runEvents, 1);
    assert.equal(outcome.deleted.documents, 1);
    assert.equal(outcome.deleted.documentRevisions, 1);
    // Scoped audit = the note, retained after the rows it describes are gone.
    assert.equal(outcome.retained.activityLog, 1, "audit activity is retained after deletion");
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

/* ── the half of a deletion that is not in the database ──────────────────────
 * "Delete my project" used to clear rows and leave two things behind: the work
 * graph under ~/.nexotao/graph/<id>/ (four such orphaned directories were found
 * on a real machine) and, since the code layer landed, a symbol-level index of
 * the user's source in a cache directory outside NEXOTAO_DATA_DIR that they were
 * never told about. Both now go with the rows.
 *
 * The second half of this test is the more important one: a purge that fails —
 * a locked cache file, a CLI that is not installed, a directory owned by
 * another user — must not fail the deletion. The rows are already gone; turning
 * that into an error would tell the user nothing was deleted when most of it
 * was. */

test("deleting a project removes its graph files and code index, and a failed purge still deletes", async () => {
  const { dir, database } = await fixture();
  try {
    const graphDir = path.join(dir, "graph", "p");
    await mkdir(graphDir, { recursive: true });
    await writeFile(path.join(graphDir, "work.json"), JSON.stringify({ nodes: [], edges: [] }));

    const dropped: string[] = [];
    const outcome = await deleteProjectData(database, "p", {
      confirm: true,
      purge: { graphDir: () => graphDir, dropCodeIndex: async (id) => { dropped.push(id); return true; } },
    });

    assert.equal(outcome.deleted.workGraph, 1, "the project's graph directory is removed");
    assert.equal(outcome.deleted.codeIndex, 1, "and its code index with it");
    assert.deepEqual(dropped, ["p"], "the index dropped is the one keyed by this project");
    assert.equal(await stat(graphDir).then(() => true, () => false), false, "nothing is left on disk");
    // The user is told about the one thing we deliberately do not touch.
    assert.match(outcome.integrityNote, /worktrees/);
    // The existing row counts still ride in the same record, so the settings
    // page's Object.values reduce picks the new keys up unchanged.
    assert.equal(outcome.deleted.agents, 0);

    // A purge where every step blows up is still a successful deletion.
    const { dir: dir2, database: database2 } = await fixture();
    try {
      const failed = await deleteProjectData(database2, "p", {
        confirm: true,
        purge: {
          graphDir: () => { throw new Error("EACCES"); },
          dropCodeIndex: async () => { throw new Error("spawn ENOENT"); },
        },
      });
      assert.equal(failed.deleted.workGraph, 0);
      assert.equal(failed.deleted.codeIndex, 0);
      assert.equal(database2.read((db) => db.select().from(projects).where(eq(projects.id, "p")).get()), undefined, "the rows are gone regardless");
    } finally {
      await database2.close();
      await rm(dir2, { recursive: true, force: true });
    }
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
