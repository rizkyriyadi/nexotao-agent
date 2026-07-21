// Paperclip-style control-plane model: persistent AGENTS (a lead + specialist
// workers) and ISSUES (the task DAG). A goal becomes a root issue assigned to
// the lead; the lead decomposes it into child issues assigned to workers with
// dependencies; the executor wakes each assignee and runs it.
import { randomUUID } from "crypto";
import { read, write, withLock } from "./store";
import type { AgentSpec } from "./store";

export type AgentRole = "lead" | "worker";
export type Agent = {
  id: string;
  projectId: string;
  name: string;
  role: AgentRole;
  scope: string;
  reportsTo: string | null; // agentId of manager (workers report to the lead)
  createdAt: number;
};

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type IssueStage = "plan" | "execute" | "integrate";

export type Issue = {
  id: string;
  projectId: string;
  ref: string;
  title: string;
  detail: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  status: IssueStatus;
  stage: IssueStage; // plan/integrate = lead phases; execute = worker
  blockedBy: string[]; // issue ids that must be `done` first
  runId: string | null; // the heartbeat run currently/last executing this issue
  summary: string;
  createdAt: number;
  updatedAt: number;
};

const AF = "agents.json";
const IF = "issues.json";

/* ── Agents ─────────────────────────────────────────────── */
export const listAgents = (projectId: string) =>
  read<Agent>(AF, "agents").then((rows) => rows.filter((a) => a.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt));
export const getAgent = (id: string) => read<Agent>(AF, "agents").then((rows) => rows.find((a) => a.id === id) ?? null);
export async function leadAgent(projectId: string) {
  return (await listAgents(projectId)).find((a) => a.role === "lead") ?? null;
}
export async function findAgentByName(projectId: string, name: string) {
  const agents = await listAgents(projectId);
  const n = name.trim().toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === n) ?? agents.find((a) => a.name.toLowerCase().includes(n)) ?? null;
}

/** Create the persistent team for a project: a Lead + one worker per spec. */
export async function seedAgents(projectId: string, team: AgentSpec[]): Promise<Agent[]> {
  return withLock(AF, async () => {
    const rows = await read<Agent>(AF, "agents");
    if (rows.some((a) => a.projectId === projectId)) return rows.filter((a) => a.projectId === projectId);
    const now = Date.now();
    const lead: Agent = { id: randomUUID(), projectId, name: "Lead", role: "lead", scope: "Plan, delegate & integrate", reportsTo: null, createdAt: now };
    const workers: Agent[] = (team ?? []).map((t, i) => ({
      id: randomUUID(), projectId, name: t.name, role: "worker" as const, scope: t.scope, reportsTo: lead.id, createdAt: now + i + 1,
    }));
    const created = [lead, ...workers];
    rows.push(...created);
    await write(AF, "agents", rows);
    return created;
  });
}

/* ── Issues ─────────────────────────────────────────────── */
export const listIssues = (projectId: string) =>
  read<Issue>(IF, "issues").then((rows) => rows.filter((i) => i.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt));
export const getIssue = (id: string) => read<Issue>(IF, "issues").then((rows) => rows.find((i) => i.id === id) ?? null);
export const childrenOf = (parentId: string) =>
  read<Issue>(IF, "issues").then((rows) => rows.filter((i) => i.parentId === parentId).sort((a, b) => a.createdAt - b.createdAt));

export async function createIssue(input: {
  projectId: string;
  title: string;
  detail?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  createdByAgentId?: string | null;
  status?: IssueStatus;
  stage?: IssueStage;
  blockedBy?: string[];
}): Promise<Issue> {
  return withLock(IF, async () => {
    const rows = await read<Issue>(IF, "issues");
    const n = rows.filter((i) => i.projectId === input.projectId).length + 1;
    const issue: Issue = {
      id: randomUUID(),
      projectId: input.projectId,
      ref: `NX-${n}`,
      title: input.title.trim() || "Untitled",
      detail: input.detail ?? "",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      status: input.status ?? "todo",
      stage: input.stage ?? "execute",
      blockedBy: input.blockedBy ?? [],
      runId: null,
      summary: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    rows.push(issue);
    await write(IF, "issues", rows);
    return issue;
  });
}

export function updateIssue(id: string, patch: Partial<Omit<Issue, "id" | "projectId" | "ref" | "createdAt">>): Promise<Issue | null> {
  return withLock(IF, async () => {
    const rows = await read<Issue>(IF, "issues");
    const it = rows.find((x) => x.id === id);
    if (it) { Object.assign(it, patch); it.updatedAt = Date.now(); }
    await write(IF, "issues", rows);
    return it ?? null;
  });
}

/** Atomically claim an issue for execution (checkout lock). Returns the issue
 * if this caller won the claim, else null (someone else is running it). */
export function claimIssue(id: string, runId: string): Promise<Issue | null> {
  return withLock(IF, async () => {
    const rows = await read<Issue>(IF, "issues");
    const it = rows.find((x) => x.id === id);
    if (!it || it.status === "in_progress" || it.status === "done" || it.status === "cancelled") return null;
    it.status = "in_progress";
    it.runId = runId;
    it.updatedAt = Date.now();
    await write(IF, "issues", rows);
    return it;
  });
}
