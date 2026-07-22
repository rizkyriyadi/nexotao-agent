import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "./db/database";
import {
  activityLog, agentConfigRevisions, agents, costEvents, heartbeatRuns, issues,
} from "./db/schema";
import { configActivityDiff } from "./governance";

export const AGENT_STATUSES = ["idle", "queued", "running", "paused", "error", "terminated"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentAction = "pause" | "resume" | "terminate" | "invoke" | "clear_error" | "retry_last_task" | "restore_revision";
export type AgentActor = { type: "user" | "agent"; id?: string | null; runId?: string | null };
export type AgentConfigInput = {
  name: string;
  role: "lead" | "worker";
  title: string;
  scope: string;
  reportsTo: string | null;
  capabilities: string[];
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  instructions: string;
  projectAccess: string[];
  concurrency: number;
  budgetLimit: number | null;
};
export type AgentEffects = {
  invoke(input: { agentId: string; issueId: string; eventId: string }): Promise<unknown>;
  cancel(runId: string, reason: string): Promise<boolean>;
  retry(runId: string): Promise<boolean>;
};

export class AgentLifecycleError extends Error {
  constructor(readonly code: "not_found" | "invalid" | "conflict" | "confirmation_required", message: string) { super(message); }
}

const activeRunStatuses = ["queued", "running", "waiting"];
const statusFromHeartbeat = (status: string): AgentStatus | null => status === "queued" ? "queued" : ["running", "waiting"].includes(status) ? "running" : status === "failed" ? "error" : null;

function cleanStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function validateConfig(input: AgentConfigInput) {
  if (!input.name.trim() || input.name.length > 80) throw new AgentLifecycleError("invalid", "Name must be between 1 and 80 characters");
  if (input.title.length > 120 || input.scope.length > 2_000 || input.instructions.length > 50_000) throw new AgentLifecycleError("invalid", "Agent text fields exceed their allowed length");
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 20) throw new AgentLifecycleError("invalid", "Concurrency must be an integer between 1 and 20");
  if (input.budgetLimit !== null && (!Number.isFinite(input.budgetLimit) || input.budgetLimit < 0)) throw new AgentLifecycleError("invalid", "Budget must be zero or greater");
}

function snapshot(row: typeof agents.$inferSelect): AgentConfigInput {
  return {
    name: row.name, role: row.role, title: row.title, scope: row.scope, reportsTo: row.reportsTo,
    capabilities: row.capabilities, adapterType: row.adapterType, adapterConfig: row.adapterConfig,
    runtimeConfig: row.runtimeConfig, permissions: row.permissions, instructions: row.instructions,
    projectAccess: row.projectAccess, concurrency: row.concurrency, budgetLimit: row.budgetLimit,
  };
}

function revisionRow(db: AppDatabase["orm"], row: typeof agents.$inferSelect, actor: AgentActor, now: number) {
  const previous = db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, row.id)).orderBy(desc(agentConfigRevisions.revision)).get();
  const revision = (previous?.revision ?? 0) + 1;
  db.insert(agentConfigRevisions).values({
    id: randomUUID(), agentId: row.id, revision,
    snapshot: snapshot(row), actorType: actor.type, actorId: actor.id ?? null, createdAt: now,
  }).run();
  return revision;
}

function auditRow(db: AppDatabase["orm"], agentId: string, action: string, summary: unknown, actor: AgentActor, now: number) {
  db.insert(activityLog).values({
    id: randomUUID(), actorType: actor.type, actorId: actor.id ?? null, action,
    entityType: "agent", entityId: agentId, summary, runId: actor.runId ?? null, createdAt: now,
  }).run();
}

export class AgentLifecycleService {
  constructor(private readonly database: AppDatabase, private readonly effects?: AgentEffects) {}

  list(projectId: string) {
    return this.database.read((db) => {
      const roster = db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.createdAt)).all();
      const projectIssues = db.select().from(issues).where(eq(issues.projectId, projectId)).all();
      return roster.map((agent) => {
        const runs = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id)).orderBy(desc(heartbeatRuns.startedAt)).all();
        const currentRun = runs.find((run) => activeRunStatuses.includes(run.status)) ?? null;
        const latestRun = runs[0] ?? null;
        const derived = currentRun ? statusFromHeartbeat(currentRun.status) : null;
        const status = (["paused", "error", "terminated"].includes(agent.status) ? agent.status : derived ?? agent.status) as AgentStatus;
        const costs = db.select().from(costEvents).where(eq(costEvents.agentId, agent.id)).orderBy(desc(costEvents.createdAt)).all();
        const spend = costs.reduce((total, event) => total + event.cost, 0) || agent.spentAmount;
        const revisions = db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id)).orderBy(desc(agentConfigRevisions.revision)).all();
        const activity = db.select().from(activityLog).where(and(eq(activityLog.entityType, "agent"), eq(activityLog.entityId, agent.id))).orderBy(desc(activityLog.createdAt)).all();
        const runDetails = runs.map((run) => ({ ...run, task: projectIssues.find((issue) => issue.id === run.issueId)?.title ?? null }));
        const latestTask = [...projectIssues].filter((issue) => issue.assigneeAgentId === agent.id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        return {
          ...agent, status, spentAmount: spend, currentRun: currentRun ? { ...currentRun, task: projectIssues.find((issue) => issue.id === currentRun.issueId)?.title ?? null } : null,
          currentTask: currentRun ? projectIssues.find((issue) => issue.id === currentRun.issueId)?.title ?? null : null,
          lastTask: latestTask ? { id: latestTask.id, title: latestTask.title, status: latestTask.status } : null,
          lastHeartbeatAt: latestRun?.updatedAt ?? latestRun?.startedAt ?? agent.lastHeartbeatAt,
          runs: runDetails, costs, revisions, activity,
        };
      });
    });
  }

  get(id: string) {
    const row = this.database.read((db) => db.select().from(agents).where(eq(agents.id, id)).get());
    if (!row) throw new AgentLifecycleError("not_found", "Agent not found");
    return row;
  }

  async create(projectId: string, raw: AgentConfigInput, actor: AgentActor = { type: "user" }) {
    const input = { ...raw, name: raw.name.trim(), title: raw.title.trim(), scope: raw.scope.trim(), capabilities: cleanStrings(raw.capabilities), projectAccess: cleanStrings(raw.projectAccess) };
    validateConfig(input);
    try {
      return await this.database.write((db) => {
        const team = db.select().from(agents).where(eq(agents.projectId, projectId)).all();
        const lead = team.find((member) => member.role === "lead");
        if (input.role === "lead" && lead) throw new AgentLifecycleError("conflict", "The beta hierarchy supports one lead");
        const reportsTo = input.role === "lead" ? null : input.reportsTo ?? lead?.id ?? null;
        if (input.role === "worker" && (!reportsTo || !team.some((member) => member.id === reportsTo && member.role === "lead" && member.status !== "terminated"))) {
          throw new AgentLifecycleError("invalid", "Specialists must report to the active lead");
        }
        const now = Date.now();
        const row: typeof agents.$inferInsert = { id: randomUUID(), projectId, ...input, reportsTo, status: "idle", spentAmount: 0, createdAt: now, updatedAt: now };
        db.insert(agents).values(row).run();
        const created = db.select().from(agents).where(eq(agents.id, row.id)).get()!;
        revisionRow(db, created, actor, now);
        auditRow(db, created.id, "agent.created", { role: created.role, name: created.name }, actor, now);
        return created;
      });
    } catch (error) {
      if (error instanceof AgentLifecycleError) throw error;
      if (String(error).toLowerCase().includes("unique")) throw new AgentLifecycleError("conflict", "An agent with this name already exists");
      throw error;
    }
  }

  async update(id: string, patch: Partial<AgentConfigInput>, actor: AgentActor = { type: "user" }) {
    return this.database.write((db) => {
      const current = db.select().from(agents).where(eq(agents.id, id)).get();
      if (!current) throw new AgentLifecycleError("not_found", "Agent not found");
      if (current.status === "terminated") throw new AgentLifecycleError("conflict", "Terminated agents cannot be edited");
      if (patch.role && patch.role !== current.role) throw new AgentLifecycleError("invalid", "Agent roles cannot be changed after creation");
      const merged: AgentConfigInput = {
        ...snapshot(current), ...patch,
        name: (patch.name ?? current.name).trim(), title: (patch.title ?? current.title).trim(), scope: (patch.scope ?? current.scope).trim(),
        capabilities: cleanStrings(patch.capabilities ?? current.capabilities), projectAccess: cleanStrings(patch.projectAccess ?? current.projectAccess),
      };
      validateConfig(merged);
      if (current.role === "lead") merged.reportsTo = null;
      else {
        const manager = merged.reportsTo ? db.select().from(agents).where(eq(agents.id, merged.reportsTo)).get() : null;
        if (!manager || manager.projectId !== current.projectId || manager.role !== "lead" || manager.status === "terminated") throw new AgentLifecycleError("invalid", "Specialists must report to the active lead");
      }
      const before = snapshot(current);
      const now = Date.now();
      db.update(agents).set({ ...merged, updatedAt: now }).where(eq(agents.id, id)).run();
      const updated = db.select().from(agents).where(eq(agents.id, id)).get()!;
      const revision = revisionRow(db, updated, actor, now);
      // Redacted before/after diff — surfaces permission, budget, and adapter
      // config changes in the audit trail without ever persisting a secret.
      auditRow(db, id, "agent.config_updated", { revision, ...configActivityDiff(before, snapshot(updated)) }, actor, now);
      return updated;
    });
  }

  async restore(id: string, revision: number, actor: AgentActor = { type: "user" }) {
    const stored = this.database.read((db) => db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.revision, revision))).get());
    if (!stored) throw new AgentLifecycleError("not_found", "Config revision not found");
    const updated = await this.update(id, stored.snapshot as AgentConfigInput, actor);
    await this.database.write((db) => { auditRow(db, id, "agent.config_restored", { revision }, actor, Date.now()); });
    return updated;
  }

  async action(id: string, action: Exclude<AgentAction, "restore_revision">, options: { confirmed?: boolean; issueId?: string } = {}, actor: AgentActor = { type: "user" }) {
    const current = this.get(id);
    const status = current.status as AgentStatus;
    const currentRun = this.database.read((db) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), inArray(heartbeatRuns.status, activeRunStatuses))).orderBy(desc(heartbeatRuns.startedAt)).get());
    let issueId = options.issueId;
    let retryRunId: string | undefined;
    if (action === "terminate" && !options.confirmed) throw new AgentLifecycleError("confirmation_required", "Termination requires confirmation");
    if (action === "pause" && !["idle", "queued", "running"].includes(status)) throw new AgentLifecycleError("conflict", `Cannot pause an agent while ${status}`);
    if (action === "resume" && status !== "paused") throw new AgentLifecycleError("conflict", "Only paused agents can be resumed");
    if (action === "clear_error" && status !== "error") throw new AgentLifecycleError("conflict", "Only agents in error can be cleared");
    if (action === "invoke") {
      if (status !== "idle") throw new AgentLifecycleError("conflict", `Cannot invoke an agent while ${status}`);
      const candidate = this.database.read((db) => issueId
        ? db.select().from(issues).where(and(eq(issues.id, issueId!), eq(issues.assigneeAgentId, id))).get()
        : db.select().from(issues).where(and(eq(issues.assigneeAgentId, id), eq(issues.status, "todo"))).orderBy(desc(issues.updatedAt)).get());
      if (!candidate || candidate.status !== "todo") throw new AgentLifecycleError("invalid", "Invoke requires an assigned task in todo");
      issueId = candidate.id;
    }
    if (action === "retry_last_task") {
      if (status !== "error") throw new AgentLifecycleError("conflict", "Retry is only available for agents in error");
      const failed = this.database.read((db) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), eq(heartbeatRuns.status, "failed"))).orderBy(desc(heartbeatRuns.startedAt)).get());
      if (!failed) throw new AgentLifecycleError("invalid", "No failed task is available to retry");
      retryRunId = failed.id;
    }
    if (action === "terminate" && status === "terminated") throw new AgentLifecycleError("conflict", "Agent is already terminated");
    if (action === "terminate" && current.role === "lead") {
      const reports = this.database.read((db) => db.select().from(agents).where(and(eq(agents.reportsTo, id), inArray(agents.status, ["idle", "queued", "running", "paused", "error"]))).all());
      if (reports.length) throw new AgentLifecycleError("conflict", "Terminate or reassign active specialists before terminating the lead");
    }
    const next: AgentStatus = action === "pause" ? "paused" : action === "terminate" ? "terminated" : ["invoke", "retry_last_task"].includes(action) ? "queued" : "idle";
    const now = Date.now();
    await this.database.write((db) => {
      db.update(agents).set({ status: next, pauseReason: action === "pause" ? "Paused by user" : null, errorReason: ["clear_error", "retry_last_task"].includes(action) ? null : current.errorReason, updatedAt: now }).where(eq(agents.id, id)).run();
      auditRow(db, id, `agent.${action}`, { from: status, to: next, issueId: issueId ?? null }, actor, now);
    });
    try {
      if (["pause", "terminate"].includes(action) && currentRun) await this.effects?.cancel(currentRun.id, action === "pause" ? "Agent paused" : "Agent terminated");
      if (action === "invoke") await this.effects?.invoke({ agentId: id, issueId: issueId!, eventId: `manual:${now}` });
      if (action === "retry_last_task" && !(await this.effects?.retry(retryRunId!))) throw new AgentLifecycleError("conflict", "The failed task could not be retried");
    } catch (error) {
      if (["invoke", "retry_last_task"].includes(action)) await this.markError(id, error instanceof Error ? error.message : String(error), actor);
      throw error;
    }
    return this.get(id);
  }

  async markError(id: string, reason: string, actor: AgentActor = { type: "agent" }) {
    return this.database.write((db) => {
      const now = Date.now();
      db.update(agents).set({ status: "error", errorReason: reason.slice(0, 2_000), updatedAt: now, lastHeartbeatAt: now }).where(eq(agents.id, id)).run();
      auditRow(db, id, "agent.error", { reason: reason.slice(0, 500) }, actor, now);
    });
  }
}
