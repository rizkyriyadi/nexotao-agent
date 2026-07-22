import { promises as fs } from "node:fs";
import path from "node:path";
import type { Database } from "sql.js";
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import { DIR, ensureDir } from "../config";
import { schema } from "./schema";
import initSqlJs from "sql.js/dist/sql-asm.js";

const DATABASE_NAME = "nexotao.sqlite";
const LEGACY_FILES = ["projects.json", "sessions.json", "tasks.json", "agent-runs.json", "runs.json", "agents.json", "issues.json"] as const;

export type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [{
  version: 1,
  name: "control-plane-foundation",
  sql: `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL, agent_specs TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, messages TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_project_updated_idx ON sessions(project_id, updated_at);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, ref TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, col TEXT NOT NULL, run_id TEXT, agent TEXT, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, ref));
CREATE INDEX IF NOT EXISTS tasks_project_col_idx ON tasks(project_id, col);
CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent TEXT NOT NULL, task TEXT NOT NULL, summary TEXT NOT NULL, ok INTEGER NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_runs_project_agent_ts_idx ON agent_runs(project_id, agent, ts);
CREATE TABLE IF NOT EXISTS run_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, events TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS run_records_project_updated_idx ON run_records(project_id, updated_at);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, reports_to TEXT REFERENCES agents(id) ON DELETE SET NULL, capabilities TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idle', adapter_type TEXT NOT NULL DEFAULT 'nexotao', adapter_config TEXT NOT NULL DEFAULT '{}', runtime_config TEXT NOT NULL DEFAULT '{}', permissions TEXT NOT NULL DEFAULT '{}', budget_limit REAL, spent_amount REAL NOT NULL DEFAULT 0, pause_reason TEXT, error_reason TEXT, last_heartbeat_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, name));
CREATE INDEX IF NOT EXISTS agents_project_status_idx ON agents(project_id, status);
CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, identifier TEXT NOT NULL, parent_id TEXT REFERENCES issues(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'execute', priority TEXT NOT NULL DEFAULT 'medium', assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, checkout_run_id TEXT, execution_locked_at INTEGER, summary TEXT NOT NULL DEFAULT '', started_at INTEGER, completed_at INTEGER, cancelled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, identifier));
CREATE INDEX IF NOT EXISTS issues_project_status_idx ON issues(project_id, status);
CREATE INDEX IF NOT EXISTS issues_parent_idx ON issues(parent_id);
CREATE INDEX IF NOT EXISTS issues_assignee_status_idx ON issues(assignee_agent_id, status);
CREATE TABLE IF NOT EXISTS issue_dependencies (issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, blocker_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(issue_id, blocker_issue_id), CHECK(issue_id <> blocker_issue_id));
CREATE INDEX IF NOT EXISTS issue_dependencies_blocker_idx ON issue_dependencies(blocker_issue_id);
CREATE TABLE IF NOT EXISTS heartbeat_runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL, source TEXT NOT NULL, status TEXT NOT NULL, session_before TEXT, session_after TEXT, usage TEXT NOT NULL DEFAULT '{}', error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS heartbeat_runs_agent_started_idx ON heartbeat_runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS heartbeat_runs_issue_idx ON heartbeat_runs(issue_id);
CREATE TABLE IF NOT EXISTS wakeup_requests (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE, reason TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(agent_id, idempotency_key));
CREATE INDEX IF NOT EXISTS wakeup_status_available_idx ON wakeup_requests(status, available_at);
CREATE TABLE IF NOT EXISTS run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, redacted_payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id, seq));
CREATE INDEX IF NOT EXISTS run_events_created_idx ON run_events(created_at);
CREATE TABLE IF NOT EXISTS issue_comments (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, author_type TEXT NOT NULL, author_id TEXT, run_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issue_comments_issue_created_idx ON issue_comments(issue_id, created_at);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS issue_documents (issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, key TEXT NOT NULL, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE, PRIMARY KEY(issue_id, key));
CREATE TABLE IF NOT EXISTS document_revisions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, revision INTEGER NOT NULL, body TEXT NOT NULL, created_by_type TEXT NOT NULL, created_by_id TEXT, created_at INTEGER NOT NULL, UNIQUE(document_id, revision));
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, type TEXT NOT NULL, issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE, run_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL, decision_note TEXT, decided_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS approvals_issue_status_idx ON approvals(issue_id, status);
CREATE TABLE IF NOT EXISTS cost_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS cost_events_agent_created_idx ON cost_events(agent_id, created_at);
CREATE INDEX IF NOT EXISTS cost_events_run_idx ON cost_events(run_id);
CREATE TABLE IF NOT EXISTS activity_log (id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_entity_created_idx ON activity_log(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity_log(created_at);
CREATE TABLE IF NOT EXISTS legacy_json_migrations (id TEXT PRIMARY KEY, backup_path TEXT NOT NULL, source_count INTEGER NOT NULL, completed_at INTEGER NOT NULL);
`,
}, {
  version: 2,
  name: "issue-lifecycle-idempotency",
  sql: `
CREATE TABLE IF NOT EXISTS issue_mutation_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, operation, idempotency_key)
);
`,
}, {
  version: 3,
  name: "durable-heartbeat-runtime",
  sql: `
ALTER TABLE heartbeat_runs ADD COLUMN wakeup_id TEXT;
ALTER TABLE heartbeat_runs ADD COLUMN queued_at INTEGER;
ALTER TABLE heartbeat_runs ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS heartbeat_runs_wakeup_uq ON heartbeat_runs(wakeup_id);
ALTER TABLE wakeup_requests ADD COLUMN run_id TEXT;
ALTER TABLE wakeup_requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wakeup_requests ADD COLUMN claimed_at INTEGER;
ALTER TABLE wakeup_requests ADD COLUMN finished_at INTEGER;
ALTER TABLE wakeup_requests ADD COLUMN last_error TEXT;
`,
}, {
  version: 4,
  name: "agent-lifecycle-management",
  sql: `
ALTER TABLE agents ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN project_access TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS agent_config_revisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, revision)
);
CREATE INDEX IF NOT EXISTS agent_config_revisions_agent_created_idx ON agent_config_revisions(agent_id, created_at);
`,
}, {
  version: 5,
  name: "isolated-git-workspaces",
  sql: `
ALTER TABLE issues ADD COLUMN workspace_path TEXT;
ALTER TABLE issues ADD COLUMN workspace_branch TEXT;
ALTER TABLE issues ADD COLUMN workspace_base_commit TEXT;
ALTER TABLE issues ADD COLUMN workspace_commit TEXT;
ALTER TABLE issues ADD COLUMN verification_status TEXT;
ALTER TABLE heartbeat_runs ADD COLUMN workspace_path TEXT;
ALTER TABLE heartbeat_runs ADD COLUMN workspace_branch TEXT;
CREATE TABLE IF NOT EXISTS git_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
  repository_path TEXT NOT NULL,
  workspace_path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  commit_sha TEXT,
  state TEXT NOT NULL,
  last_validated_at INTEGER,
  recovery_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS git_workspaces_state_idx ON git_workspaces(state);
`,
}, {
  version: 6,
  name: "persistent-execution-approvals",
  sql: `
ALTER TABLE approvals ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE approvals ADD COLUMN tool_call_id TEXT;
ALTER TABLE approvals ADD COLUMN action TEXT;
ALTER TABLE approvals ADD COLUMN target TEXT;
ALTER TABLE approvals ADD COLUMN risk TEXT;
ALTER TABLE approvals ADD COLUMN preview TEXT;
ALTER TABLE approvals ADD COLUMN expires_at INTEGER;
ALTER TABLE approvals ADD COLUMN resumed_at INTEGER;
CREATE INDEX IF NOT EXISTS approvals_project_status_idx ON approvals(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_run_tool_uq ON approvals(run_id, tool_call_id);
`,
}, {
  version: 7,
  name: "issue-run-mode",
  sql: `
ALTER TABLE issues ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'agent';
`,
}];

// Applies pending migrations, each in its own IMMEDIATE transaction so a failing
// migration rolls back atomically and leaves the schema at its last good version.
// Throws on the first failure without closing the connection so callers can inspect
// (or discard) the rolled-back database.
export function applyMigrations(raw: Database, list: Migration[] = migrations): void {
  raw.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set((raw.exec("SELECT version FROM schema_migrations")[0]?.values ?? []).map((row) => Number(row[0])));
  for (const migration of list) {
    if (applied.has(migration.version)) continue;
    raw.run("BEGIN IMMEDIATE");
    try {
      raw.run(migration.sql);
      raw.run("INSERT INTO schema_migrations VALUES (?, ?, ?)", [migration.version, migration.name, Date.now()]);
      raw.run("COMMIT");
    } catch (error) {
      raw.run("ROLLBACK");
      throw error;
    }
  }
}

export class AppDatabase {
  readonly orm: SQLJsDatabase<typeof schema>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly raw: Database, readonly file: string) {
    this.orm = drizzle(raw, { schema });
  }

  read<T>(fn: (db: SQLJsDatabase<typeof schema>) => T): T { return fn(this.orm); }

  write<T>(fn: (db: SQLJsDatabase<typeof schema>) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      let result!: T;
      this.raw.run("BEGIN IMMEDIATE");
      try { result = fn(this.orm); this.raw.run("COMMIT"); }
      catch (error) { this.raw.run("ROLLBACK"); throw error; }
      await persist(this.raw, this.file);
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async close() { await this.queue; await persist(this.raw, this.file); this.raw.close(); }
}

async function persist(db: Database, file: string) {
  const temp = file + ".tmp";
  await fs.writeFile(temp, Buffer.from(db.export()), { mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}

async function readLegacy<T>(dir: string, file: string, key: string): Promise<T[]> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, file), "utf8"))[key] ?? []) as T[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function migrateLegacyJson(db: Database, dir: string) {
  if (db.exec("SELECT id FROM legacy_json_migrations WHERE id = 'json-v1'")[0]?.values.length) return;
  const present: string[] = [];
  for (const file of LEGACY_FILES) { try { await fs.access(path.join(dir, file)); present.push(file); } catch {} }
  const completedAt = Date.now();
  const backup = path.join(dir, "backups", `json-v1-${completedAt}`);
  if (present.length) {
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    await Promise.all(present.map(async (file) => {
      const target = path.join(backup, file);
      await fs.copyFile(path.join(dir, file), target);
      await fs.chmod(target, 0o600);
    }));
  }
  const projects = await readLegacy<any>(dir, "projects.json", "projects");
  const sessions = await readLegacy<any>(dir, "sessions.json", "sessions");
  const tasks = await readLegacy<any>(dir, "tasks.json", "tasks");
  const agentRuns = await readLegacy<any>(dir, "agent-runs.json", "runs");
  const runRecords = await readLegacy<any>(dir, "runs.json", "runs");
  const agents = await readLegacy<any>(dir, "agents.json", "agents");
  const issues = await readLegacy<any>(dir, "issues.json", "issues");
  db.run("BEGIN IMMEDIATE");
  try {
    for (const p of projects) db.run("INSERT OR IGNORE INTO projects VALUES (?, ?, ?, ?, ?, ?)", [p.id, p.name, p.path, p.mode, JSON.stringify(p.agents ?? []), p.createdAt]);
    for (const s of sessions) db.run("INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?, ?, ?)", [s.id, s.projectId, s.title, JSON.stringify(s.messages ?? []), s.createdAt, s.updatedAt]);
    for (const t of tasks) db.run("INSERT OR IGNORE INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [t.id, t.ref, t.projectId, t.title, t.col, t.runId ?? null, t.agent ?? null, t.summary ?? null, t.createdAt, t.updatedAt ?? t.createdAt]);
    for (const r of agentRuns) db.run("INSERT OR IGNORE INTO agent_runs VALUES (?, ?, ?, ?, ?, ?, ?)", [r.id, r.projectId, r.agent, r.task, r.summary, r.ok ? 1 : 0, r.ts]);
    for (const r of runRecords) db.run("INSERT OR IGNORE INTO run_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [r.id, r.projectId, r.kind, r.title, r.status, JSON.stringify(r.events ?? []), r.createdAt, r.updatedAt]);
    for (const a of agents) db.run("INSERT OR IGNORE INTO agents (id, project_id, name, role, scope, reports_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [a.id, a.projectId, a.name, a.role, a.scope, a.reportsTo ?? null, a.createdAt, a.createdAt]);
    for (const i of issues) db.run("INSERT OR IGNORE INTO issues (id, project_id, identifier, parent_id, title, description, status, stage, assignee_agent_id, created_by_agent_id, checkout_run_id, execution_locked_at, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [i.id, i.projectId, i.ref, i.parentId ?? null, i.title, i.detail ?? "", i.status, i.stage, i.assigneeAgentId ?? null, i.createdByAgentId ?? null, i.runId ?? null, i.runId ? i.updatedAt : null, i.summary ?? "", i.createdAt, i.updatedAt]);
    for (const i of issues) for (const blocker of i.blockedBy ?? []) db.run("INSERT OR IGNORE INTO issue_dependencies VALUES (?, ?, ?)", [i.id, blocker, i.createdAt]);
    db.run("INSERT INTO legacy_json_migrations VALUES ('json-v1', ?, ?, ?)", [present.length ? backup : "", present.length, completedAt]);
    db.run("COMMIT");
  } catch (error) { db.run("ROLLBACK"); throw error; }
 }

export async function openDatabase(file = path.join(DIR, DATABASE_NAME), options: { migrateJson?: boolean } = {}) {
  ensureDir();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const SQL = await initSqlJs();
  let bytes: Uint8Array | undefined;
  try { bytes = await fs.readFile(file); } catch {}
  const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
  raw.run("PRAGMA foreign_keys = ON");
  try { applyMigrations(raw, migrations); }
  catch (error) { raw.close(); throw error; }
  if (options.migrateJson !== false) await migrateLegacyJson(raw, path.dirname(file));
  await persist(raw, file);
  return new AppDatabase(raw, file);
}

let applicationDatabase: Promise<AppDatabase> | undefined;
export function getDatabase() { applicationDatabase ??= openDatabase(); return applicationDatabase; }
