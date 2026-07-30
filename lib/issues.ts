import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getDatabase, STATUS_TO_DEFAULT_STATE, defaultStateId } from "./db/database";
import { agents, issueDependencies, issues, workflowStates } from "./db/schema";
import { IssueDomainError, IssueLifecycleService, type IssueActor, type IssueStatus as LifecycleStatus } from "./issue-lifecycle";

export type AgentRole = "lead" | "worker";
export type Agent = { id: string; projectId: string; name: string; role: AgentRole; scope: string; avatar: string | null; status: string; createdAt: number };
/** Re-exported from the lifecycle, which owns the transition table; declaring the
 *  union twice let the two drift and the board render a status the engine
 *  rejected. */
export type { IssueStatus } from "./issue-lifecycle";
type IssueStatusValue = LifecycleStatus;
export type IssueStage = "plan" | "execute" | "integrate";
export type RunMode = "agent" | "plan" | "ask";
export type Issue = {
  id: string; projectId: string; ref: string; title: string; detail: string; parentId: string | null;
  assigneeAgentId: string | null; status: IssueStatusValue; stage: IssueStage;
  priority: string; runMode: RunMode; blockedBy: string[]; runId: string | null; summary: string; createdAt: number; updatedAt: number;
  // Per-conversation model. Null means the project/agent default applies.
  model: string | null;
  // `stateId` is the board column the card sits in; `status` above stays the
  // engine's truth about the work itself.
  stateId: string | null; startDate: number | null; targetDate: number | null;
};

// `status` is projected because blocker attention needs it: a blocker assigned
// to a paused or errored agent is not waiting, it is stuck, and defaulting the
// status here would silently classify those as healthy.
const agentFromRow = (row: typeof agents.$inferSelect): Agent => ({ id: row.id, projectId: row.projectId, name: row.name, role: row.role, scope: row.scope, avatar: row.avatar ?? null, status: row.status, createdAt: row.createdAt });
function issueFromRow(row: typeof issues.$inferSelect, links: { blockedBy: string[] }): Issue {
  return { id: row.id, projectId: row.projectId, ref: row.identifier, title: row.title, detail: row.description, parentId: row.parentId,
    assigneeAgentId: row.assigneeAgentId, status: row.status as IssueStatusValue,
    stage: row.stage as IssueStage, priority: row.priority, runMode: (row.runMode as RunMode) ?? "agent", blockedBy: links.blockedBy,
    runId: row.checkoutRunId, summary: row.summary, createdAt: row.createdAt, updatedAt: row.updatedAt,
    model: row.model ?? null,
    stateId: row.stateId ?? null, startDate: row.startDate ?? null, targetDate: row.targetDate ?? null };
}
async function hydrate(rows: Array<typeof issues.$inferSelect>) {
  const database = await getDatabase();
  const ids = rows.map((row) => row.id);
  if (!ids.length) return [];
  const deps = database.read((db) =>
    db.select().from(issueDependencies).where(inArray(issueDependencies.issueId, ids)).all());
  return rows.map((row) => issueFromRow(row, {
    blockedBy: deps.filter((dep) => dep.issueId === row.id).map((dep) => dep.blockerIssueId),
  }));
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
/** The model an agent is routed to (adapterConfig.model), if any. Blueprints
 *  pin a recommended model per role; the executor prefers it over the global
 *  default so per-role routing takes effect. */
export async function getAgentModel(id: string): Promise<string | null> {
  const database = await getDatabase();
  const row = database.read((db) => db.select().from(agents).where(eq(agents.id, id)).get());
  const model = (row?.adapterConfig as { model?: unknown } | undefined)?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}
/** Give a project its agent. Every issue is assigned to one, so a project
 *  without this row cannot start a run at all. Idempotent: a project that
 *  already has an agent keeps it. */
export async function seedAgents(projectId: string): Promise<Agent[]> {
  const database = await getDatabase();
  return database.write((db) => {
    const existing = db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.createdAt)).all();
    if (existing.length) return existing.map(agentFromRow);
    const now = Date.now();
    const lead: Agent = { id: randomUUID(), projectId, name: "Hutao", role: "lead", scope: "Handles your requests end-to-end — answers, plans, and builds", avatar: null, status: "idle", createdAt: now };
    db.insert(agents).values({ ...lead, updatedAt: lead.createdAt }).run();
    return [lead];
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
export async function createIssue(input: {
  projectId: string; title: string; detail?: string; parentId?: string | null; assigneeAgentId?: string | null;
  status?: IssueStatusValue; stage?: IssueStage; blockedBy?: string[];
  priority?: string; runMode?: RunMode; model?: string | null;
  stateId?: string | null; startDate?: number | null; targetDate?: number | null;
  idempotencyKey?: string; actor?: IssueActor;
}): Promise<Issue> {
  const database = await getDatabase();
  const row = await new IssueLifecycleService(database).create({
    projectId: input.projectId, title: input.title, description: input.detail, parentId: input.parentId,
    assigneeAgentId: input.assigneeAgentId, status: input.status,
    stage: input.stage, priority: input.priority, runMode: input.runMode, blockerIds: input.blockedBy, idempotencyKey: input.idempotencyKey, actor: input.actor,
  });
  // The lifecycle owns `status`; the board column and the scheduling dates are
  // applied here so the lifecycle never has to know about them. Without an
  // explicit column, the card lands in the default one for its status — that is
  // what keeps agent-created issues visible on the board.
  // `create` is idempotent: an existing key returns the row already stored, and
  // that row may have been moved since, so only fill a column that is still empty.
  // The column is resolved against the rows that actually exist — a project may
  // have none yet, and an issue with no column still renders, placed by its status
  // (see resolveStateId in lib/board-columns.ts).
  const preferred = input.stateId ?? row.stateId ?? defaultStateId(input.projectId, STATUS_TO_DEFAULT_STATE[row.status] ?? "backlog");
  const stateId = database.read((db) => db.select({ id: workflowStates.id }).from(workflowStates).where(eq(workflowStates.id, preferred)).get())?.id ?? null;
  await database.write((db) => {
    db.update(issues).set({
      stateId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
    }).where(eq(issues.id, row.id)).run();
  });
  return (await getIssue(row.id))!;
}
export async function updateIssue(
  id: string,
  patch: Partial<Omit<Issue, "id" | "projectId" | "ref" | "createdAt">>,
  actor: IssueActor = { type: "system" },
): Promise<Issue | null> {
  const database = await getDatabase();
  const lifecycle = new IssueLifecycleService(database);
  const before = await getIssue(id);
  if (!before) return null;
  if (patch.runId !== undefined) throw new IssueDomainError("conflict", "Checkout locks must be changed through checkout or release");
  await database.write((db) => {
    db.update(issues).set({
      ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.detail !== undefined ? { description: patch.detail } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}), updatedAt: Date.now(),
    }).where(eq(issues.id, id)).run();
  });
  if (patch.assigneeAgentId !== undefined) await lifecycle.assign(id, patch.assigneeAgentId, actor);
  if (patch.blockedBy !== undefined) await lifecycle.setDependencies(id, patch.blockedBy, actor);
  if (patch.status !== undefined && patch.status !== before.status) {
    if (patch.status === "in_progress") throw new IssueDomainError("invalid_transition", "Issues enter in_progress only through checkout");
    await lifecycle.transition(id, patch.status, actor);
  }
  return getIssue(id);
}
export async function reopenIssue(id: string, actor: IssueActor = { type: "user" }, runMode?: RunMode): Promise<Issue | null> {
  const database = await getDatabase();
  const before = await getIssue(id);
  if (!before) return null;
  const row = await new IssueLifecycleService(database).reopen(id, actor, runMode);
  return (await hydrate([row]))[0];
}
export async function claimIssue(id: string, agentId: string, runId: string): Promise<Issue | null> {
  const database = await getDatabase();
  try {
    await new IssueLifecycleService(database).checkout(id, agentId, runId);
    return getIssue(id);
  } catch (error) {
    if (error instanceof IssueDomainError && ["conflict", "forbidden", "not_found"].includes(error.code)) return null;
    throw error;
  }
}
export async function releaseIssue(issueId: string, agentId: string, runId: string, reason?: string) {
  const database = await getDatabase();
  const row = await new IssueLifecycleService(database).release({ issueId, agentId, runId, reason });
  return (await hydrate([row]))[0];
}
export async function recoverStaleIssues(staleAfterMs: number, activeRunIds: Iterable<string> = []) {
  const database = await getDatabase();
  const rows = await new IssueLifecycleService(database).recover({ staleAfterMs, activeRunIds });
  return hydrate(rows);
}
