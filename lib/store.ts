import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "./db/database";
import { agentRuns, projects, runRecords, sessions, tasks } from "./db/schema";

export type AgentSpec = { name: string; scope: string };
export type Project = { id: string; name: string; path: string; mode: "single" | "multi"; agents: AgentSpec[]; createdAt: number };
export type Message = { role: "user" | "assistant"; content: string };
export type Session = { id: string; projectId: string; title: string; createdAt: number; updatedAt: number; messages: Message[] };
export type Col = "backlog" | "todo" | "in_progress" | "review" | "done";
export type Task = { id: string; ref: string; projectId: string; title: string; col: Col; createdAt: number; runId?: string; agent?: string; summary?: string; updatedAt?: number };
export type AgentRun = { id: string; projectId: string; agent: string; task: string; summary: string; ok: boolean; ts: number };
export type RunRecord = { id: string; projectId: string; kind: "chat" | "orchestrator"; title: string; status: "running" | "done" | "error" | "cancelled"; createdAt: number; updatedAt: number; events: any[] };

const projectFromRow = (row: typeof projects.$inferSelect): Project => ({ id: row.id, name: row.name, path: row.path, mode: row.mode, agents: row.agentSpecs, createdAt: row.createdAt });
const taskFromRow = (row: typeof tasks.$inferSelect): Task => ({ id: row.id, ref: row.ref, projectId: row.projectId, title: row.title, col: row.col as Col, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.runId ? { runId: row.runId } : {}), ...(row.agent ? { agent: row.agent } : {}), ...(row.summary ? { summary: row.summary } : {}) });
const runFromRow = (row: typeof runRecords.$inferSelect): RunRecord => ({ ...row, events: row.events as any[] });

export async function listProjects() {
  const database = await getDatabase();
  return database.read((db) => db.select().from(projects).orderBy(asc(projects.createdAt)).all().map(projectFromRow));
}
export async function getProject(id: string) { return (await listProjects()).find((project) => project.id === id) ?? null; }
export async function addProject(input: Omit<Project, "id" | "createdAt">): Promise<Project> {
  const database = await getDatabase();
  const project: Project = { ...input, id: randomUUID(), createdAt: Date.now() };
  await database.write((db) => db.insert(projects).values({ id: project.id, name: project.name, path: project.path, mode: project.mode, agentSpecs: project.agents, createdAt: project.createdAt }).run());
  return project;
}
export async function getActiveProject(): Promise<Project | null> {
  const { getConfig } = await import("./config");
  const config = await getConfig();
  return config.activeProjectId ? getProject(config.activeProjectId) : null;
}

export async function listSessions(projectId?: string) {
  const database = await getDatabase();
  const rows = database.read((db) => db.select().from(sessions).where(projectId ? eq(sessions.projectId, projectId) : undefined).orderBy(desc(sessions.updatedAt)).all());
  return rows as Session[];
}
export async function getSession(id: string) {
  const database = await getDatabase();
  return database.read((db) => db.select().from(sessions).where(eq(sessions.id, id)).get() as Session | undefined) ?? null;
}
export async function createSession(projectId: string, title: string): Promise<Session> {
  const database = await getDatabase();
  const now = Date.now();
  const session: Session = { id: randomUUID(), projectId, title: title.slice(0, 80) || "New session", createdAt: now, updatedAt: now, messages: [] };
  await database.write((db) => db.insert(sessions).values(session).run());
  return session;
}
export async function saveSessionMessages(id: string, messages: Message[], title?: string) {
  const database = await getDatabase();
  return database.write((db) => {
    const current = db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!current) return null;
    const nextTitle = title && (!current.title || current.title === "New session") ? title.slice(0, 80) : current.title;
    db.update(sessions).set({ messages, title: nextTitle, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
    return db.select().from(sessions).where(eq(sessions.id, id)).get() as Session;
  });
}

export async function listTasks(projectId?: string) {
  const database = await getDatabase();
  return database.read((db) => db.select().from(tasks).where(projectId ? eq(tasks.projectId, projectId) : undefined).all().map(taskFromRow));
}
export async function addTask(projectId: string, title: string, opts?: { col?: Col; runId?: string; agent?: string; summary?: string }): Promise<Task> {
  const database = await getDatabase();
  return database.write((db) => {
    const now = Date.now();
    const n = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId)).all().length + 1;
    const task: Task = { id: randomUUID(), ref: `#${n}`, projectId, title: title.trim() || "Untitled", col: opts?.col ?? "todo", createdAt: now, updatedAt: now, runId: opts?.runId, agent: opts?.agent, summary: opts?.summary };
    db.insert(tasks).values({ ...task, runId: task.runId ?? null, agent: task.agent ?? null, summary: task.summary ?? null, updatedAt: now }).run();
    return task;
  });
}
export async function updateTask(id: string, patch: Partial<Pick<Task, "col" | "title" | "summary">>) {
  const database = await getDatabase();
  return database.write((db) => {
    db.update(tasks).set({ ...patch, updatedAt: Date.now() }).where(eq(tasks.id, id)).run();
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? taskFromRow(row) : null;
  });
}

export async function listAgentRuns(projectId?: string, agent?: string) {
  const database = await getDatabase();
  const rows = database.read((db) => db.select().from(agentRuns).orderBy(desc(agentRuns.ts)).all());
  return rows.filter((row) => (!projectId || row.projectId === projectId) && (!agent || row.agent === agent));
}
export async function addAgentRun(projectId: string, input: { agent: string; task: string; summary: string; ok: boolean }): Promise<AgentRun> {
  const database = await getDatabase();
  const row: AgentRun = { id: randomUUID(), projectId, ts: Date.now(), ...input };
  await database.write((db) => db.insert(agentRuns).values(row).run());
  return row;
}

export async function listRunRecords(projectId?: string) {
  const database = await getDatabase();
  return database.read((db) => db.select().from(runRecords).where(projectId ? eq(runRecords.projectId, projectId) : undefined).orderBy(desc(runRecords.updatedAt)).all().map(runFromRow));
}
export async function getRunRecord(id: string) {
  const database = await getDatabase();
  const row = database.read((db) => db.select().from(runRecords).where(eq(runRecords.id, id)).get());
  return row ? runFromRow(row) : null;
}
export async function saveRunRecord(record: RunRecord) {
  const database = await getDatabase();
  await database.write((db) => {
    db.insert(runRecords).values(record).onConflictDoUpdate({ target: runRecords.id, set: { title: record.title, status: record.status, events: record.events, updatedAt: record.updatedAt } }).run();
    const excess = db.select({ id: runRecords.id }).from(runRecords).orderBy(desc(runRecords.updatedAt)).all().slice(60).map((row) => row.id);
    if (excess.length) db.delete(runRecords).where(inArray(runRecords.id, excess)).run();
  });
}
