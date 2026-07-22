import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { applyMigrations, migrations, openDatabase, type Migration } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { createRunEventStream } from "../lib/run-event-stream";
import { agents, projects } from "../lib/db/schema";

function tableExists(raw: import("sql.js").Database, name: string): boolean {
  return (raw.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name])[0]?.values.length ?? 0) > 0;
}

function appliedVersions(raw: import("sql.js").Database): number[] {
  return (raw.exec("SELECT version FROM schema_migrations ORDER BY version")[0]?.values ?? []).map((row) => Number(row[0]));
}

// A migration whose first statement succeeds and whose second statement fails, so a
// non-atomic runner would leave `fault_probe` behind. The atomic runner must not.
const FAILING_MIGRATION: Migration = {
  version: 9001,
  name: "deliberately-broken",
  sql: `CREATE TABLE fault_probe (id TEXT PRIMARY KEY);
INSERT INTO fault_probe (id) SELECT missing_column FROM issues;`,
};

test("a failing migration rolls back atomically and leaves the last good schema version", async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run("PRAGMA foreign_keys = ON");

  applyMigrations(raw, migrations);
  const good = appliedVersions(raw);
  assert.deepEqual(good, migrations.map((migration) => migration.version), "all real migrations apply cleanly");
  assert.ok(tableExists(raw, "issues"), "a known table from the applied schema exists");

  assert.throws(() => applyMigrations(raw, [FAILING_MIGRATION]), /missing_column|no such column/i);
  assert.equal(tableExists(raw, "fault_probe"), false, "the partial DDL of the failed migration is rolled back");
  assert.deepEqual(appliedVersions(raw), good, "schema_migrations does not record the failed version");

  // Recovery: re-applying the real (good) migration set after a failed attempt is a
  // clean no-op — the runner is idempotent and the database is still usable.
  assert.doesNotThrow(() => applyMigrations(raw, migrations));
  assert.deepEqual(appliedVersions(raw), good);
  raw.close();
});

test("an injected fault inside a write transaction rolls back and does not wedge the queue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-fault-write-"));
  const file = path.join(dir, "nexotao.sqlite");
  try {
    const database = await openDatabase(file, { migrateJson: false });
    await database.write((db) => db.insert(projects).values({ id: "p", name: "Fault", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());

    // Inject a fault after a valid mutation: the transaction must roll the row back.
    await assert.rejects(
      database.write((db) => {
        db.insert(agents).values({ id: "ghost", projectId: "p", name: "Ghost", role: "worker", scope: "x", createdAt: 2, updatedAt: 2 }).run();
        throw new Error("injected mid-transaction fault");
      }),
      /injected mid-transaction fault/,
    );
    assert.equal(database.read((db) => db.select().from(agents).all()).length, 0, "the mutation before the fault was rolled back");

    // The write queue is not wedged: a subsequent write still commits.
    await database.write((db) => db.insert(agents).values({ id: "real", projectId: "p", name: "Real", role: "worker", scope: "x", createdAt: 3, updatedAt: 3 }).run());
    assert.deepEqual(database.read((db) => db.select().from(agents).all()).map((row) => row.id), ["real"]);
    await database.close();

    // Persistence integrity: reopening from disk shows only committed state.
    const reopened = await openDatabase(file, { migrateJson: false });
    assert.deepEqual(reopened.read((db) => db.select().from(agents).all()).map((row) => row.id), ["real"]);
    await reopened.close();
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
});

test("a crash mid-run keeps events durable and replays from the cursor without gaps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-fault-crash-"));
  const file = path.join(dir, "nexotao.sqlite");
  try {
    const database = await openDatabase(file, { migrateJson: false });
    await database.write((db) => db.insert(projects).values({ id: "p", name: "Crash", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
    let repositories = new ControlPlaneRepositories(database);
    await repositories.agents.insert({ id: "a", projectId: "p", name: "Agent", role: "worker", scope: "x", createdAt: 2, updatedAt: 2 });
    await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Crash", status: "in_progress", assigneeAgentId: "a", createdAt: 3, updatedAt: 3 });

    await repositories.enqueueHeartbeat({ agentId: "a", issueId: "i", reason: "assignment", idempotencyKey: "assignment:i:1" });
    const claimed = await repositories.claimNextHeartbeat();
    assert.ok(claimed, "the queued heartbeat is claimable");
    const runId = claimed!.heartbeat.id;
    await repositories.appendHeartbeatEvent(runId, "output", { text: "one" });
    await repositories.appendHeartbeatEvent(runId, "output", { text: "two" });

    // Simulate a crash: persist and drop the connection without completing the run.
    await database.close();

    const reopened = await openDatabase(file, { migrateJson: false });
    repositories = new ControlPlaneRepositories(reopened);
    const events = repositories.listRunEvents(runId);
    assert.deepEqual(events.map((event) => event.seq), [1, 2], "events survived the crash and kept their sequence");
    assert.equal(repositories.getHeartbeat(runId)?.status, "running", "the run is orphaned in a non-terminal state");

    // Orphan recovery returns the run to the queue exactly once and it is re-claimable.
    assert.equal(await repositories.recoverOrphanedHeartbeats(), 1);
    assert.equal(await repositories.recoverOrphanedHeartbeats(), 0, "recovery is idempotent");
    assert.ok(await repositories.claimNextHeartbeat(), "the recovered run is claimable again");

    // Cursor replay after reconnect delivers only unseen events, no gaps or duplicates.
    const reader = createRunEventStream(repositories, runId, 1).getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /"seq":2/);
    assert.doesNotMatch(chunk, /"seq":1/);
    await reader.cancel();
    await reopened.close();
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
});
