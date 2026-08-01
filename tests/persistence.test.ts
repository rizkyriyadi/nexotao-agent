import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { applyMigrations, migrations, openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";

async function fixture() { return mkdtemp(path.join(tmpdir(), "nexotao-db-test-")); }

test("control-plane records survive a database restart", async () => {
  const dir = await fixture();
  const file = path.join(dir, "nexotao.sqlite");
  try {
    let database = await openDatabase(file, { migrateJson: false });
    await database.write((db) => db.insert(projects).values({ id: "project-1", name: "Example", path: dir, createdAt: 1 }).run());
    let repositories = new ControlPlaneRepositories(database);
    await repositories.agents.insert({ id: "agent-1", projectId: "project-1", name: "Lead", role: "lead", scope: "Lead", createdAt: 2, updatedAt: 2 });
    await repositories.issues.insert({ id: "issue-1", projectId: "project-1", identifier: "NX-1", title: "Persist", status: "todo", assigneeAgentId: "agent-1", createdAt: 3, updatedAt: 3 });
    const checkouts = await Promise.all([repositories.checkoutIssue("issue-1", "agent-1", "run-1"), repositories.checkoutIssue("issue-1", "agent-1", "run-2")]);
    assert.equal(checkouts.filter(Boolean).length, 1);
    await repositories.addComment({ issueId: "issue-1", authorType: "user", body: "keep me" });
    await repositories.putDocument({ issueId: "issue-1", key: "plan", body: "revision one", createdByType: "agent" });
    await repositories.putDocument({ issueId: "issue-1", key: "plan", body: "revision two", createdByType: "agent" });
    await repositories.createHeartbeat({ agentId: "agent-1", issueId: "issue-1", source: "assignment", status: "done", startedAt: 4, finishedAt: 5 });
    const firstWakeup = await repositories.enqueueWakeup({ agentId: "agent-1", issueId: "issue-1", reason: "assignment", idempotencyKey: "wake-1", status: "queued", availableAt: 6 });
    const sameWakeup = await repositories.enqueueWakeup({ agentId: "agent-1", issueId: "issue-1", reason: "duplicate", idempotencyKey: "wake-1", status: "queued", availableAt: 7 });
    assert.equal(sameWakeup.id, firstWakeup.id);
    await repositories.appendRunEvent({ runId: "run-1", seq: 1, type: "status", redactedPayload: { status: "done" }, createdAt: 8 });
    await repositories.createApproval({ type: "shell", issueId: "issue-1", runId: "run-1", payload: { command: "npm test" }, status: "approved" });
    await repositories.appendActivity({ actorType: "agent", actorId: "agent-1", action: "completed", entityType: "issue", entityId: "issue-1", summary: { status: "done" }, runId: "run-1" });
    await database.close();

    database = await openDatabase(file, { migrateJson: false });
    repositories = new ControlPlaneRepositories(database);
    assert.equal(repositories.agents.get("agent-1")?.name, "Lead");
    assert.equal(repositories.issues.get("issue-1")?.title, "Persist");
    assert.deepEqual(repositories.listComments("issue-1").map((row) => row.body), ["keep me"]);
    assert.deepEqual(repositories.listDocumentRevisions("issue-1", "plan").map((row) => row.revision), [1, 2]);
    assert.equal(repositories.listHeartbeats("agent-1").length, 1);
    assert.equal(repositories.listWakeups().length, 1);
    assert.equal(repositories.listRunEvents("run-1").length, 1);
    assert.equal(repositories.listApprovals("issue-1").length, 1);
    assert.deepEqual(repositories.listActivity("issue", "issue-1").map((row) => row.action), ["issue.checked_out", "completed"]);
    await database.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy JSON migration is idempotent and creates a recoverable backup", async () => {
  const dir = await fixture();
  const file = path.join(dir, "nexotao.sqlite");
  try {
    await writeFile(path.join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "Legacy", path: dir, mode: "multi", agents: [], createdAt: 1 }] }));
    await writeFile(path.join(dir, "agents.json"), JSON.stringify({ agents: [{ id: "a", projectId: "p", name: "Lead", role: "lead", scope: "Lead", createdAt: 2 }] }));
    await writeFile(path.join(dir, "issues.json"), JSON.stringify({ issues: [{ id: "i", projectId: "p", ref: "NX-1", title: "Legacy issue", detail: "kept", parentId: null, assigneeAgentId: "a", status: "todo", stage: "execute", blockedBy: [], runId: null, summary: "", createdAt: 3, updatedAt: 3 }] }));
    let database = await openDatabase(file);
    assert.equal(new ControlPlaneRepositories(database).issues.get("i")?.description, "kept");
    await database.close();
    database = await openDatabase(file);
    assert.equal(new ControlPlaneRepositories(database).issues.list("p").length, 1);
    const backups = await readdir(path.join(dir, "backups"));
    assert.equal(backups.length, 1);
    assert.match(await readFile(path.join(dir, "backups", backups[0], "issues.json"), "utf8"), /Legacy issue/);
    await database.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ── migration 12: the worktree columns go, the snapshot columns arrive ───────
 * Every install that has ever run a task is on version 11 with a `git_workspaces`
 * row per run and a branch name on every issue. Those rows describe worktrees
 * this release stops creating, on branches nothing will ever merge — but they
 * sit in the same tables as the user's actual work, so the interesting question
 * is not whether they are dropped. It is whether everything beside them survives
 * being dropped, on SQLite, where a DROP COLUMN rewrites the table. */

const columnsOf = (raw: any, table: string): string[] =>
  (raw.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((row: unknown[]) => String(row[1]));

const tableExists = (raw: any, table: string) =>
  Boolean(raw.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`)[0]?.values.length);

/** A database at version 11 with one project's worth of real work in it, plus
 *  the worktree bookkeeping migration 12 exists to remove. */
async function databaseAtV11() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  applyMigrations(raw, migrations.filter((m) => m.version <= 11));
  raw.run("INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'Example', '/tmp/example', 1)");
  raw.run("INSERT INTO agents (id, project_id, name, role, scope, created_at, updated_at) VALUES ('a', 'p', 'Hutao', 'lead', 'Lead', 2, 2)");
  raw.run(`INSERT INTO issues (id, project_id, identifier, title, status, summary, created_at, updated_at,
    workspace_path, workspace_branch, workspace_base_commit, workspace_commit, verification_status)
    VALUES ('i', 'p', 'NX-1', 'Ship it', 'in_review', 'done the thing', 3, 3,
    '/home/u/.nexotao/worktrees/abc/nx-1', 'nexotao/nx-1/run-1', 'aaa', 'bbb', 'passed')`);
  raw.run(`INSERT INTO heartbeat_runs (id, agent_id, issue_id, source, status, started_at, workspace_path, workspace_branch)
    VALUES ('run-1', 'a', 'i', 'assignment', 'done', 4, '/home/u/.nexotao/worktrees/abc/nx-1', 'nexotao/nx-1/run-1')`);
  raw.run(`INSERT INTO git_workspaces (id, project_id, issue_id, run_id, repository_path, workspace_path, branch, target_branch, base_commit, state, created_at, updated_at)
    VALUES ('w', 'p', 'i', 'run-1', '/home/u/code/app', '/home/u/.nexotao/worktrees/abc/nx-1', 'nexotao/nx-1/run-1', 'main', 'aaa', 'ready', 5, 5)`);
  return raw;
}

test("migration 12 retires the worktree bookkeeping and leaves the work beside it", async () => {
  const raw = await databaseAtV11();
  try {
    assert.ok(tableExists(raw, "git_workspaces"), "the fixture really is a version-11 database");

    applyMigrations(raw, migrations);

    assert.equal(tableExists(raw, "git_workspaces"), false);
    for (const column of ["workspace_path", "workspace_branch", "workspace_base_commit", "workspace_commit", "verification_status"]) {
      assert.ok(!columnsOf(raw, "issues").includes(column), `issues.${column} is gone`);
    }
    for (const column of ["workspace_path", "workspace_branch"]) {
      assert.ok(!columnsOf(raw, "heartbeat_runs").includes(column), `heartbeat_runs.${column} is gone`);
    }
    assert.ok(columnsOf(raw, "heartbeat_runs").includes("snapshot_commit"));
    assert.ok(columnsOf(raw, "heartbeat_runs").includes("snapshot_head"));

    // The rows themselves — a DROP COLUMN rewrites the table, so this is the
    // assertion that matters: the user's issue and its run are still there, with
    // the fields they had, and the issue is still parked where the run left it.
    const issue = raw.exec("SELECT identifier, title, status, summary FROM issues WHERE id = 'i'")[0]?.values[0];
    assert.deepEqual(issue, ["NX-1", "Ship it", "in_review", "done the thing"]);
    const run = raw.exec("SELECT agent_id, issue_id, status, snapshot_commit FROM heartbeat_runs WHERE id = 'run-1'")[0]?.values[0];
    assert.deepEqual(run, ["a", "i", "done", null], "the new columns start empty rather than invented");

    // And a snapshot can actually be recorded against that run — the column is a
    // real column, not just a name in PRAGMA output.
    raw.run("UPDATE heartbeat_runs SET snapshot_commit = 'cafe', snapshot_head = 'beef' WHERE id = 'run-1'");
    assert.deepEqual(
      raw.exec("SELECT snapshot_commit, snapshot_head FROM heartbeat_runs WHERE id = 'run-1'")[0]?.values[0],
      ["cafe", "beef"],
    );
  } finally { raw.close(); }
});

test("migration 12 runs once, however many times the app starts", async () => {
  const raw = await databaseAtV11();
  try {
    applyMigrations(raw, migrations);
    // The second pass is the one that would throw: `DROP COLUMN` on a column that
    // is already gone is an error, and `ADD COLUMN` on one that already exists is
    // a duplicate. Nothing here is guarded by IF EXISTS — the version table is
    // what makes it safe, so this is a test of that table.
    applyMigrations(raw, migrations);
    applyMigrations(raw, migrations);
    assert.deepEqual(raw.exec("SELECT COUNT(*) FROM schema_migrations WHERE version = 12")[0]?.values[0], [1]);
    assert.deepEqual(raw.exec("SELECT identifier FROM issues WHERE id = 'i'")[0]?.values[0], ["NX-1"]);
  } finally { raw.close(); }
});
