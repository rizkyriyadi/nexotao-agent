// Local JSON store — the app's database, persisted to ~/.nexotao. No native deps
// so `npm install` needs no compilation.
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DIR, ensureDir, getConfig } from "./config";

export type AgentSpec = { name: string; scope: string };
export type Project = { id: string; name: string; path: string; mode: "single" | "multi"; agents: AgentSpec[]; createdAt: number };
export type Message = { role: "user" | "assistant"; content: string };
export type Session = { id: string; projectId: string; title: string; createdAt: number; updatedAt: number; messages: Message[] };
export type Col = "backlog" | "todo" | "in_progress" | "review" | "done";
export type Task = { id: string; ref: string; projectId: string; title: string; col: Col; createdAt: number };
export type AgentRun = { id: string; projectId: string; agent: string; task: string; summary: string; ok: boolean; ts: number };
export type RunRecord = {
  id: string;
  projectId: string;
  kind: "chat" | "orchestrator";
  title: string;
  status: "running" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  events: any[]; // full event log — lets a finished run be replayed for viewing
};

async function read<T>(file: string, key: string): Promise<T[]> {
  try {
    return (JSON.parse(await fs.readFile(path.join(DIR, file), "utf8"))[key] ?? []) as T[];
  } catch {
    return [];
  }
}
async function write<T>(file: string, key: string, rows: T[]) {
  ensureDir();
  await fs.writeFile(path.join(DIR, file), JSON.stringify({ [key]: rows }, null, 2), "utf8");
}

/* ── Projects ─────────────────────────────────────────── */
export const listProjects = () => read<Project>("projects.json", "projects");
export async function getProject(id: string) {
  return (await listProjects()).find((p) => p.id === id) ?? null;
}
export async function addProject(p: Omit<Project, "id" | "createdAt">): Promise<Project> {
  const rows = await listProjects();
  const proj: Project = { ...p, id: randomUUID(), createdAt: Date.now() };
  rows.push(proj);
  await write("projects.json", "projects", rows);
  return proj;
}
export async function getActiveProject(): Promise<Project | null> {
  const c = await getConfig();
  if (!c.activeProjectId) return null;
  return getProject(c.activeProjectId);
}

/* ── Sessions ─────────────────────────────────────────── */
export const listSessions = async (projectId?: string) => {
  const rows = await read<Session>("sessions.json", "sessions");
  return (projectId ? rows.filter((s) => s.projectId === projectId) : rows).sort((a, b) => b.updatedAt - a.updatedAt);
};
export async function getSession(id: string) {
  return (await read<Session>("sessions.json", "sessions")).find((s) => s.id === id) ?? null;
}
export async function createSession(projectId: string, title: string): Promise<Session> {
  const rows = await read<Session>("sessions.json", "sessions");
  const s: Session = { id: randomUUID(), projectId, title: title.slice(0, 80) || "New session", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  rows.push(s);
  await write("sessions.json", "sessions", rows);
  return s;
}
export async function saveSessionMessages(id: string, messages: Message[], title?: string) {
  const rows = await read<Session>("sessions.json", "sessions");
  const s = rows.find((x) => x.id === id);
  if (!s) return null;
  s.messages = messages;
  s.updatedAt = Date.now();
  if (title && (!s.title || s.title === "New session")) s.title = title.slice(0, 80);
  await write("sessions.json", "sessions", rows);
  return s;
}

/* ── Tasks ────────────────────────────────────────────── */
export const listTasks = async (projectId?: string) => {
  const rows = await read<Task>("tasks.json", "tasks");
  return projectId ? rows.filter((t) => t.projectId === projectId) : rows;
};
export async function addTask(projectId: string, title: string): Promise<Task> {
  const rows = await read<Task>("tasks.json", "tasks");
  const n = rows.filter((t) => t.projectId === projectId).length + 1;
  const t: Task = { id: randomUUID(), ref: `#${n}`, projectId, title: title.trim() || "Untitled", col: "todo", createdAt: Date.now() };
  rows.push(t);
  await write("tasks.json", "tasks", rows);
  return t;
}
export async function updateTask(id: string, patch: Partial<Pick<Task, "col" | "title">>) {
  const rows = await read<Task>("tasks.json", "tasks");
  const t = rows.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  await write("tasks.json", "tasks", rows);
  return t ?? null;
}

/* ── Agent history (what each sub-agent worked on) ─────── */
export const listAgentRuns = async (projectId?: string, agent?: string) => {
  const rows = await read<AgentRun>("agent-runs.json", "runs");
  return rows
    .filter((r) => (projectId ? r.projectId === projectId : true) && (agent ? r.agent === agent : true))
    .sort((a, b) => b.ts - a.ts);
};
export async function addAgentRun(projectId: string, r: { agent: string; task: string; summary: string; ok: boolean }): Promise<AgentRun> {
  const rows = await read<AgentRun>("agent-runs.json", "runs");
  const run: AgentRun = { id: randomUUID(), projectId, ts: Date.now(), ...r };
  rows.push(run);
  await write("agent-runs.json", "runs", rows);
  return run;
}

/* ── Runs (durable event logs — every AI run, viewable any time) ── */
export const listRunRecords = async (projectId?: string) => {
  const rows = await read<RunRecord>("runs.json", "runs");
  return (projectId ? rows.filter((r) => r.projectId === projectId) : rows).sort((a, b) => b.updatedAt - a.updatedAt);
};
export async function getRunRecord(id: string) {
  return (await read<RunRecord>("runs.json", "runs")).find((r) => r.id === id) ?? null;
}
export async function saveRunRecord(rec: RunRecord) {
  const rows = await read<RunRecord>("runs.json", "runs");
  const i = rows.findIndex((r) => r.id === rec.id);
  if (i >= 0) rows[i] = rec; else rows.push(rec);
  // keep only the most recent 60 runs on disk
  const trimmed = rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
  await write("runs.json", "runs", trimmed);
}
