import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "./db/database";
import { agents, issueDependencies, issues } from "./db/schema";
import type { AgentSpec } from "./store";

export type AgentRole = "lead" | "worker";
export type Agent = { id: string; projectId: string; name: string; role: AgentRole; scope: string; reportsTo: string | null; createdAt: number };
export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type IssueStage = "plan" | "execute" | "integrate";
export type Issue = {
  id: string; projectId: string; ref: string; title: string; detail: string; parentId: string | null;
  assigneeAgentId: string | null; createdByAgentId: string | null; status: IssueStatus; stage: IssueStage;
  blockedBy: string[]; runId: string | null; summary: string; createdAt: number; updatedAt: number;
};

const agentFromRow = (row: typeof agents.$inferSelect): Agent => ({ id: row.id, projectId: row.projectId, name: row.name, role: row.role, scope: row.scope, reportsTo: row.reportsTo, createdAt: row.createdAt });
function issueFromRow(row: typeof issues.$inferSelect, blockedBy: string[]): Issue {
  return { id: row.id, projectId: row.projectId, ref: row.identifier, title: row.title, detail: row.description, parentId: row.parentId,
    assigneeAgentId: row.assigneeAgentId, createdByAgentId: row.createdByAgentId, status: row.status as IssueStatus,
    stage: row.stage as IssueStage, blockedBy, runId: row.checkoutRunId, summary: row.summary, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
async function hydrate(rows: Array<typeof issues.$inferSelect>) {
  const database = await getDatabase();
  const ids = rows.map((row) => row.id);
  const deps = ids.length ? database.read((db) => db.select().from(issueDependencies).where(inArray(issueDependencies.issueId, ids)).all()) : [];
  return rows.map((row) => issueFromRow(row, deps.filter((dep) => dep.issueId === row.id).map((dep) => dep.blockerIssueId)));
}

export async function listAgents(projectId: string) {
  const database = await getDatabase();
  return database.read((db) => db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.createdAt)).all().map(agentFromRow));
}
export async function getAgent(id: string) {
  const database = await getDatabase();
  const row = database.read((db) => db.select().from(agents).where(eq(agents.id, id)).get());
  return row ? agentFromRow(row) : null;
}
export async function leadAgent(projectId: string) { return (await listAgents(projectId)).find((agent) => agent.role === "lead") ?? null; }
export async function findAgentByName(projectId: string, name: string) {
  const all = await listAgents(projectId); const normalized = name.trim().toLowerCase();
  return all.find((agent) => agent.name.toLowerCase() === normalized) ?? all.find((agent) => agent.name.toLowerCase().includes(normalized)) ?? null;
}
export async function seedAgents(projectId: string, team: AgentSpec[]): Promise<Agent[]> {
  const database = await getDatabase();
  return database.write((db) => {
    const existing = db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.createdAt)).all();
    if (existing.length) return existing.map(agentFromRow);
    const now = Date.now();
    const lead: Agent = { id: randomUUID(), projectId, name: "Lead", role: "lead", scope: "Plan, delegate & integrate", reportsTo: null, createdAt: now };
    const workers: Agent[] = (team ?? []).map((spec, index) => ({ id: randomUUID(), projectId, name: spec.name, role: "worker", scope: spec.scope, reportsTo: lead.id, createdAt: now + index + 1 }));
    for (const agent of [lead, ...workers]) db.insert(agents).values({ ...agent, updatedAt: agent.createdAt }).run();
    return [lead, ...workers];
  });
}

export async function listIssues(projectId: string) {
  const database = await getDatabase();
  return hydrate(database.read((db) => db.select().from(issues).where(eq(issues.projectId, projectId)).orderBy(asc(issues.createdAt)).all()));
}
export async function getIssue(id: string) {
  const database = await getDatabase();
  const row = database.read((db) => db.select().from(issues).where(eq(issues.id, id)).get());
  return row ? (await hydrate([row]))[0] : null;
}
export async function childrenOf(parentId: string) {
  const database = await getDatabase();
  return hydrate(database.read((db) => db.select().from(issues).where(eq(issues.parentId, parentId)).orderBy(asc(issues.createdAt)).all()));
}
export async function createIssue(input: { projectId: string; title: string; detail?: string; parentId?: string | null; assigneeAgentId?: string | null; createdByAgentId?: string | null; status?: IssueStatus; stage?: IssueStage; blockedBy?: string[] }): Promise<Issue> {
  const database = await getDatabase();
  return database.write((db) => {
    const now = Date.now();
    const count = db.select({ id: issues.id }).from(issues).where(eq(issues.projectId, input.projectId)).all().length;
    const issue: Issue = { id: randomUUID(), projectId: input.projectId, ref: `NX-${count + 1}`, title: input.title.trim() || "Untitled", detail: input.detail ?? "", parentId: input.parentId ?? null, assigneeAgentId: input.assigneeAgentId ?? null, createdByAgentId: input.createdByAgentId ?? null, status: input.status ?? "todo", stage: input.stage ?? "execute", blockedBy: input.blockedBy ?? [], runId: null, summary: "", createdAt: now, updatedAt: now };
    db.insert(issues).values({ id: issue.id, projectId: issue.projectId, identifier: issue.ref, parentId: issue.parentId, title: issue.title, description: issue.detail, status: issue.status, stage: issue.stage, assigneeAgentId: issue.assigneeAgentId, createdByAgentId: issue.createdByAgentId, summary: issue.summary, createdAt: now, updatedAt: now }).run();
    for (const blockerIssueId of issue.blockedBy) db.insert(issueDependencies).values({ issueId: issue.id, blockerIssueId, createdAt: now }).run();
    return issue;
  });
}
export async function updateIssue(id: string, patch: Partial<Omit<Issue, "id" | "projectId" | "ref" | "createdAt">>): Promise<Issue | null> {
  const database = await getDatabase();
  await database.write((db) => {
    const current = db.select().from(issues).where(eq(issues.id, id)).get();
    if (!current) return;
    db.update(issues).set({
      ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.detail !== undefined ? { description: patch.detail } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}), ...(patch.assigneeAgentId !== undefined ? { assigneeAgentId: patch.assigneeAgentId } : {}),
      ...(patch.createdByAgentId !== undefined ? { createdByAgentId: patch.createdByAgentId } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}), ...(patch.runId !== undefined ? { checkoutRunId: patch.runId, executionLockedAt: patch.runId ? Date.now() : null } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}), updatedAt: Date.now(),
    }).where(eq(issues.id, id)).run();
    if (patch.blockedBy) {
      db.delete(issueDependencies).where(eq(issueDependencies.issueId, id)).run();
      for (const blockerIssueId of patch.blockedBy) db.insert(issueDependencies).values({ issueId: id, blockerIssueId, createdAt: Date.now() }).run();
    }
  });
  return getIssue(id);
}
export async function claimIssue(id: string, runId: string): Promise<Issue | null> {
  const database = await getDatabase();
  const claimed = await database.write((db) => {
    const row = db.select().from(issues).where(eq(issues.id, id)).get();
    if (!row || row.checkoutRunId || ["in_progress", "done", "cancelled"].includes(row.status)) return false;
    const deps = db.select().from(issueDependencies).where(eq(issueDependencies.issueId, id)).all();
    const blockers = deps.length ? db.select().from(issues).where(inArray(issues.id, deps.map((dep) => dep.blockerIssueId))).all() : [];
    if (blockers.some((blocker) => blocker.status !== "done")) return false;
    const now = Date.now();
    db.update(issues).set({ status: "in_progress", checkoutRunId: runId, executionLockedAt: now, startedAt: row.startedAt ?? now, updatedAt: now }).where(eq(issues.id, id)).run();
    return true;
  });
  return claimed ? getIssue(id) : null;
}
