import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { AppDatabase } from "./database";
import {
  activityLog, agents, approvals, costEvents, documentRevisions, documents, gitWorkspaces, heartbeatRuns,
  issueComments, issueDependencies, issueDocuments, issues, runEvents, wakeupRequests,
} from "./schema";
import { IssueDomainError, IssueLifecycleService } from "../issue-lifecycle";
import {
  isTerminalRunEvent, publishRunEvent, RunEventDomainError, sanitizeRunEventPayload,
  type DurableRunEvent,
} from "../run-events";
import { budgetStatus, crossedThresholds, settleUsage, type RunUsage } from "../cost-ledger";

export type NewAgent = typeof agents.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type GitWorkspaceRow = typeof gitWorkspaces.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type WakeupReason = "assignment" | "invoke" | "mention" | "approval" | "dependency" | "retry";
export type HeartbeatStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type ClaimedHeartbeat = {
  wakeup: typeof wakeupRequests.$inferSelect;
  heartbeat: typeof heartbeatRuns.$inferSelect;
};

export interface AgentRepository {
  list(projectId: string): AgentRow[];
  get(id: string): AgentRow | null;
  insert(row: NewAgent): Promise<AgentRow>;
}
export interface IssueRepository {
  list(projectId: string): IssueRow[];
  get(id: string): IssueRow | null;
  insert(row: NewIssue): Promise<IssueRow>;
  update(id: string, patch: Partial<NewIssue>): Promise<IssueRow | null>;
}

export class ControlPlaneRepositories {
  readonly agents: AgentRepository;
  readonly issues: IssueRepository;

  constructor(private readonly database: AppDatabase) {
    this.agents = {
      list: (projectId) => database.read((db) => db.select().from(agents).where(eq(agents.projectId, projectId)).orderBy(asc(agents.createdAt)).all()),
      get: (id) => database.read((db) => db.select().from(agents).where(eq(agents.id, id)).get() ?? null),
      insert: (row) => database.write((db) => { db.insert(agents).values(row).run(); return db.select().from(agents).where(eq(agents.id, row.id)).get()!; }),
    };
    this.issues = {
      list: (projectId) => database.read((db) => db.select().from(issues).where(eq(issues.projectId, projectId)).orderBy(asc(issues.createdAt)).all()),
      get: (id) => database.read((db) => db.select().from(issues).where(eq(issues.id, id)).get() ?? null),
      insert: (row) => database.write((db) => { db.insert(issues).values(row).run(); return db.select().from(issues).where(eq(issues.id, row.id)).get()!; }),
      update: (id, patch) => database.write((db) => { db.update(issues).set(patch).where(eq(issues.id, id)).run(); return db.select().from(issues).where(eq(issues.id, id)).get() ?? null; }),
    };
  }

  listDependencies(issueId: string) {
    return this.database.read((db) => db.select().from(issueDependencies).where(eq(issueDependencies.issueId, issueId)).all());
  }
  addDependency(issueId: string, blockerIssueId: string) {
    return this.database.write((db) => db.insert(issueDependencies).values({ issueId, blockerIssueId, createdAt: Date.now() }).onConflictDoNothing().run());
  }
  async checkoutIssue(issueId: string, agentId: string, runId: string) {
    try {
      return await new IssueLifecycleService(this.database).checkout(issueId, agentId, runId);
    } catch (error) {
      if (error instanceof IssueDomainError && ["conflict", "forbidden", "not_found"].includes(error.code)) return null;
      throw error;
    }
  }
  addComment(input: { issueId: string; authorType: string; authorId?: string | null; runId?: string | null; body: string }) {
    const row = { id: randomUUID(), createdAt: Date.now(), authorId: null, runId: null, ...input };
    return this.database.write((db) => { db.insert(issueComments).values(row).run(); return row; });
  }
  listComments(issueId: string) {
    return this.database.read((db) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(asc(issueComments.createdAt)).all());
  }
  createHeartbeat(input: Omit<typeof heartbeatRuns.$inferInsert, "id">) {
    const row = { id: randomUUID(), ...input };
    return this.database.write((db) => { db.insert(heartbeatRuns).values(row).run(); return row; });
  }
  listHeartbeats(agentId: string) {
    return this.database.read((db) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(desc(heartbeatRuns.startedAt)).all());
  }
  getHeartbeat(id: string) {
    return this.database.read((db) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).get() ?? null);
  }
  enqueueHeartbeat(input: {
    agentId: string; issueId?: string | null; reason: WakeupReason; idempotencyKey: string; availableAt?: number;
  }) {
    const now = Date.now();
    return this.database.write((db) => {
      const existing = db.select().from(wakeupRequests).where(and(eq(wakeupRequests.agentId, input.agentId), eq(wakeupRequests.idempotencyKey, input.idempotencyKey))).get();
      if (existing) {
        const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupId, existing.id)).get();
        return { wakeup: existing, heartbeat: heartbeat! };
      }
      if (input.issueId) {
        const active = db.select().from(wakeupRequests).where(and(
          eq(wakeupRequests.agentId, input.agentId), eq(wakeupRequests.issueId, input.issueId),
          inArray(wakeupRequests.status, ["queued", "running"]),
        )).get();
        if (active) return { wakeup: active, heartbeat: db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupId, active.id)).get()! };
      }
      const wakeup = {
        id: randomUUID(), agentId: input.agentId, issueId: input.issueId ?? null, reason: input.reason,
        idempotencyKey: input.idempotencyKey, status: "queued", availableAt: input.availableAt ?? now,
        runId: null, attempt: 0, claimedAt: null, finishedAt: null, lastError: null, createdAt: now,
      };
      const heartbeat = {
        id: randomUUID(), agentId: input.agentId, issueId: input.issueId ?? null, wakeupId: wakeup.id,
        source: input.reason, status: "queued", sessionBefore: null, sessionAfter: null, usage: {}, error: null,
        queuedAt: now, startedAt: now, updatedAt: now, finishedAt: null,
      };
      db.insert(wakeupRequests).values(wakeup).run();
      db.insert(heartbeatRuns).values(heartbeat).run();
      const agent = db.select().from(agents).where(eq(agents.id, input.agentId)).get();
      if (agent && !["paused", "error", "terminated"].includes(agent.status)) db.update(agents).set({ status: "queued", updatedAt: now }).where(eq(agents.id, input.agentId)).run();
      return { wakeup, heartbeat };
    });
  }
  getWorkspace(runId: string) {
    return this.database.read((db) => db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, runId)).get() ?? null);
  }
  listWorkspaces(projectId?: string) {
    return this.database.read((db) => db.select().from(gitWorkspaces).where(projectId ? eq(gitWorkspaces.projectId, projectId) : undefined).orderBy(asc(gitWorkspaces.createdAt)).all());
  }
  assignWorkspace(input: {
    id: string; projectId: string; issueId: string; runId: string; repositoryPath: string; workspacePath: string;
    branch: string; targetBranch: string; baseCommit: string;
  }) {
    return this.database.write((db) => {
      const issue = db.select().from(issues).where(eq(issues.id, input.issueId)).get();
      const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).get();
      if (!issue || issue.projectId !== input.projectId || issue.checkoutRunId !== input.runId || issue.status !== "in_progress") {
        throw new IssueDomainError("conflict", "Run does not own the issue workspace assignment");
      }
      if (!heartbeat || heartbeat.issueId !== input.issueId || !["running", "waiting"].includes(heartbeat.status)) {
        throw new IssueDomainError("conflict", "Heartbeat is not active for the issue workspace assignment");
      }
      const existing = db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, input.runId)).get();
      if (existing) {
        if (existing.workspacePath !== input.workspacePath || existing.branch !== input.branch) {
          throw new IssueDomainError("conflict", "Run already has a different workspace assignment");
        }
        return existing;
      }
      const now = Date.now();
      const row: typeof gitWorkspaces.$inferInsert = {
        ...input, commitSha: null, state: "active", lastValidatedAt: now, recoveryNote: null, createdAt: now, updatedAt: now,
      };
      db.insert(gitWorkspaces).values(row).run();
      db.update(issues).set({
        workspacePath: input.workspacePath, workspaceBranch: input.branch, workspaceBaseCommit: input.baseCommit,
        workspaceCommit: null, verificationStatus: "active", updatedAt: now,
      }).where(eq(issues.id, input.issueId)).run();
      db.update(heartbeatRuns).set({ workspacePath: input.workspacePath, workspaceBranch: input.branch, updatedAt: now })
        .where(eq(heartbeatRuns.id, input.runId)).run();
      return db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, input.runId)).get()!;
    });
  }
  touchWorkspace(runId: string) {
    return this.database.write((db) => {
      const now = Date.now();
      db.update(gitWorkspaces).set({ lastValidatedAt: now, updatedAt: now }).where(eq(gitWorkspaces.runId, runId)).run();
      return db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, runId)).get() ?? null;
    });
  }
  recordWorkspaceCommit(runId: string, commitSha: string, state: "committed" | "verified" | "rejected") {
    return this.database.write((db) => {
      const workspace = db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, runId)).get();
      if (!workspace) throw new IssueDomainError("not_found", "Workspace assignment not found");
      const now = Date.now();
      db.update(gitWorkspaces).set({ commitSha, state, updatedAt: now }).where(eq(gitWorkspaces.runId, runId)).run();
      db.update(issues).set({ workspaceCommit: commitSha, verificationStatus: state, updatedAt: now }).where(eq(issues.id, workspace.issueId)).run();
      return db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, runId)).get()!;
    });
  }
  markWorkspaceState(runId: string, state: "active" | "committed" | "verified" | "rejected" | "orphaned" | "recovered" | "cleaned", recoveryNote?: string | null) {
    return this.database.write((db) => {
      const now = Date.now();
      db.update(gitWorkspaces).set({ state, recoveryNote: recoveryNote ?? null, updatedAt: now }).where(eq(gitWorkspaces.runId, runId)).run();
      return db.select().from(gitWorkspaces).where(eq(gitWorkspaces.runId, runId)).get() ?? null;
    });
  }
  claimNextHeartbeat(now = Date.now()): Promise<ClaimedHeartbeat | null> {
    return this.database.write((db) => {
      const candidates = db.select().from(wakeupRequests).where(eq(wakeupRequests.status, "queued"))
        .orderBy(asc(wakeupRequests.availableAt), asc(wakeupRequests.createdAt)).all().filter((row) => row.availableAt <= now);
      for (const candidate of candidates) {
        const agent = db.select().from(agents).where(eq(agents.id, candidate.agentId)).get();
        if (!agent || ["paused", "error", "terminated"].includes(agent.status)) continue;
        // Spent-at-or-above budget defers new wakeups: the request stays queued
        // (recoverable if the budget is raised) but is never claimed while the
        // agent is over budget.
        const agentSpend = db.select().from(costEvents).where(eq(costEvents.agentId, candidate.agentId)).all()
          .reduce((total, row) => total + row.cost, 0);
        if (budgetStatus(agentSpend, agent.budgetLimit).exhausted) continue;
        const concurrency = Math.max(1, agent.concurrency);
        const active = db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, candidate.agentId), inArray(heartbeatRuns.status, ["running", "waiting"]))).all().length;
        if (active >= concurrency) continue;
        const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupId, candidate.id)).get();
        if (!heartbeat) continue;
        const runId = heartbeat.id;
        db.update(wakeupRequests).set({ status: "running", runId, claimedAt: now, attempt: candidate.attempt + 1, lastError: null }).where(eq(wakeupRequests.id, candidate.id)).run();
        db.update(heartbeatRuns).set({ status: "running", startedAt: now, updatedAt: now, finishedAt: null, error: null }).where(eq(heartbeatRuns.id, heartbeat.id)).run();
        db.update(agents).set({ status: "running", errorReason: null, updatedAt: now, lastHeartbeatAt: now }).where(eq(agents.id, candidate.agentId)).run();
        return {
          wakeup: db.select().from(wakeupRequests).where(eq(wakeupRequests.id, candidate.id)).get()!,
          heartbeat: db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.id)).get()!,
        };
      }
      return null;
    });
  }
  transitionHeartbeat(runId: string, status: "running" | "waiting", patch: {
    sessionBefore?: string | null; sessionAfter?: string | null; usage?: Record<string, unknown>; error?: string | null;
  } = {}) {
    return this.database.write((db) => {
      const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get();
      if (!heartbeat) return null;
      const now = Date.now();
      db.update(heartbeatRuns).set({ ...patch, status, updatedAt: now, finishedAt: null }).where(eq(heartbeatRuns.id, runId)).run();
      if (heartbeat.wakeupId) db.update(wakeupRequests).set({ status: "running", finishedAt: null, lastError: patch.error ?? null }).where(eq(wakeupRequests.id, heartbeat.wakeupId)).run();
      return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get() ?? null;
    });
  }
  requeueHeartbeat(runId: string, availableAt: number, error?: string) {
    return this.database.write((db) => {
      const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get();
      if (!heartbeat?.wakeupId) return false;
      const now = Date.now();
      db.update(heartbeatRuns).set({ status: "queued", error: error ?? null, updatedAt: now, finishedAt: null }).where(eq(heartbeatRuns.id, runId)).run();
      db.update(wakeupRequests).set({ status: "queued", availableAt, runId: null, claimedAt: null, finishedAt: null, lastError: error ?? null }).where(eq(wakeupRequests.id, heartbeat.wakeupId)).run();
      db.update(agents).set({ status: "queued", errorReason: null, updatedAt: now }).where(eq(agents.id, heartbeat.agentId)).run();
      return true;
    });
  }
  recoverOrphanedHeartbeats() {
    return this.database.write((db) => {
      const orphaned = db.select().from(wakeupRequests).where(eq(wakeupRequests.status, "running")).all();
      const now = Date.now();
      for (const wakeup of orphaned) {
        db.update(wakeupRequests).set({ status: "queued", runId: null, claimedAt: null, finishedAt: null, lastError: "Recovered after runtime restart" }).where(eq(wakeupRequests.id, wakeup.id)).run();
        db.update(heartbeatRuns).set({ status: "queued", error: "Recovered after runtime restart", updatedAt: now, finishedAt: null }).where(eq(heartbeatRuns.wakeupId, wakeup.id)).run();
        db.update(agents).set({ status: "queued", updatedAt: now }).where(eq(agents.id, wakeup.agentId)).run();
      }
      return orphaned.length;
    });
  }
  async appendHeartbeatEvent(runId: string, type: string, payload: unknown) {
    const redactedPayload = sanitizeRunEventPayload(payload);
    const row = await this.database.write((db) => {
      const last = db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(desc(runEvents.seq)).get();
      if (last && isTerminalRunEvent(last.type)) throw new RunEventDomainError("terminal", `Run ${runId} already has a terminal event`);
      const row = { runId, seq: (last?.seq ?? 0) + 1, type, redactedPayload, createdAt: Date.now() };
      db.insert(runEvents).values(row).run();
      return row;
    });
    publishRunEvent(row);
    return row;
  }
  async completeHeartbeat(runId: string, status: "succeeded" | "failed" | "cancelled", payload: unknown, patch: {
    sessionBefore?: string | null; sessionAfter?: string | null; usage?: Record<string, unknown>; error?: string | null;
  } = {}) {
    const type = status === "succeeded" ? "success" : status === "failed" ? "failure" : "cancelled";
    const redactedPayload = sanitizeRunEventPayload(payload);
    const result = await this.database.write((db) => {
      const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get();
      if (!heartbeat) throw new RunEventDomainError("not_found", `Run ${runId} does not exist`);
      const last = db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(desc(runEvents.seq)).get();
      if (last && isTerminalRunEvent(last.type)) throw new RunEventDomainError("terminal", `Run ${runId} already has a terminal event`);
      const now = Date.now();
      const event = { runId, seq: (last?.seq ?? 0) + 1, type, redactedPayload, createdAt: now };
      db.insert(runEvents).values(event).run();
      db.update(heartbeatRuns).set({ ...patch, status, updatedAt: now, finishedAt: now }).where(eq(heartbeatRuns.id, runId)).run();
      if (heartbeat.wakeupId) db.update(wakeupRequests).set({ status, finishedAt: now, lastError: patch.error ?? null }).where(eq(wakeupRequests.id, heartbeat.wakeupId)).run();
      const agent = db.select().from(agents).where(eq(agents.id, heartbeat.agentId)).get();
      if (agent && !["paused", "terminated"].includes(agent.status)) {
        const next = status === "failed" ? "error" : "idle";
        db.update(agents).set({ status: next, errorReason: status === "failed" ? patch.error ?? "Heartbeat failed" : null, lastHeartbeatAt: now, updatedAt: now }).where(eq(agents.id, heartbeat.agentId)).run();
        if (status === "failed") db.insert(activityLog).values({ id: randomUUID(), actorType: "agent", actorId: heartbeat.agentId, action: "agent.error", entityType: "agent", entityId: heartbeat.agentId, summary: { runId, error: patch.error ?? null }, runId, createdAt: now }).run();
      }
      return { event, heartbeat: db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get()! };
    });
    publishRunEvent(result.event);
    return result;
  }
  enqueueWakeup(input: Omit<typeof wakeupRequests.$inferInsert, "id" | "createdAt">) {
    const row = { id: randomUUID(), createdAt: Date.now(), ...input };
    return this.database.write((db) => {
      db.insert(wakeupRequests).values(row).onConflictDoNothing().run();
      return db.select().from(wakeupRequests).where(and(eq(wakeupRequests.agentId, input.agentId), eq(wakeupRequests.idempotencyKey, input.idempotencyKey))).get()!;
    });
  }
  listWakeups(status?: string) {
    return this.database.read((db) => db.select().from(wakeupRequests).where(status ? eq(wakeupRequests.status, status) : undefined).orderBy(asc(wakeupRequests.availableAt)).all());
  }
  appendRunEvent(input: typeof runEvents.$inferInsert) {
    return this.appendHeartbeatEvent(input.runId, input.type, input.redactedPayload);
  }
  listRunEvents(runId: string, afterSeq = 0, limit = 500): DurableRunEvent[] {
    return this.database.read((db) => db.select().from(runEvents).where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq))).orderBy(asc(runEvents.seq)).limit(limit).all());
  }
  listIssueRunEvents(issueId: string, limit = 500): DurableRunEvent[] {
    const runs = this.database.read((db) => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId)).all());
    return runs.flatMap((run) => this.listRunEvents(run.id, 0, limit)).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq).slice(-limit);
  }
  listProjectRunEvents(projectId: string, limit = 500): DurableRunEvent[] {
    const projectAgents = this.agents.list(projectId).map((agent) => agent.id);
    if (!projectAgents.length) return [];
    const runs = this.database.read((db) => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, projectAgents)).all());
    return runs.flatMap((run) => this.listRunEvents(run.id, 0, limit)).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq).slice(-limit);
  }
  putDocument(input: { issueId: string; key: string; body: string; createdByType: string; createdById?: string | null }) {
    return this.database.write((db) => {
      const linked = db.select().from(issueDocuments).where(and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, input.key))).get();
      const now = Date.now();
      const documentId = linked?.documentId ?? randomUUID();
      if (!linked) {
        db.insert(documents).values({ id: documentId, createdAt: now, updatedAt: now }).run();
        db.insert(issueDocuments).values({ issueId: input.issueId, key: input.key, documentId }).run();
      } else db.update(documents).set({ updatedAt: now }).where(eq(documents.id, documentId)).run();
      const previous = db.select().from(documentRevisions).where(eq(documentRevisions.documentId, documentId)).orderBy(desc(documentRevisions.revision)).get();
      const revision = (previous?.revision ?? 0) + 1;
      const row = { id: randomUUID(), documentId, revision, body: input.body, createdByType: input.createdByType, createdById: input.createdById ?? null, createdAt: now };
      db.insert(documentRevisions).values(row).run();
      return row;
    });
  }
  listDocumentRevisions(issueId: string, key: string) {
    return this.database.read((db) => {
      const linked = db.select().from(issueDocuments).where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key))).get();
      return linked ? db.select().from(documentRevisions).where(eq(documentRevisions.documentId, linked.documentId)).orderBy(asc(documentRevisions.revision)).all() : [];
    });
  }
  createApproval(input: Omit<typeof approvals.$inferInsert, "id" | "createdAt">) {
    const row = { id: randomUUID(), createdAt: Date.now(), ...input };
    return this.database.write((db) => {
      if (row.runId && row.toolCallId) {
        const existing = db.select().from(approvals).where(and(eq(approvals.runId, row.runId), eq(approvals.toolCallId, row.toolCallId))).get();
        if (existing) return existing;
      }
      db.insert(approvals).values(row).run();
      return db.select().from(approvals).where(eq(approvals.id, row.id)).get()!;
    });
  }
  listApprovals(issueId: string) {
    return this.database.read((db) => db.select().from(approvals).where(eq(approvals.issueId, issueId)).orderBy(asc(approvals.createdAt)).all());
  }
  listProjectApprovals(projectId: string, status?: string) {
    return this.database.read((db) => db.select().from(approvals).where(and(eq(approvals.projectId, projectId), status ? eq(approvals.status, status) : undefined)).orderBy(asc(approvals.createdAt)).all());
  }
  addCost(input: Omit<typeof costEvents.$inferInsert, "id" | "createdAt">) {
    const row = { id: randomUUID(), createdAt: Date.now(), ...input };
    return this.database.write((db) => { db.insert(costEvents).values(row).run(); return row; });
  }
  /** Persist the settled cost of a heartbeat run and reconcile the agent's
   * budget. Idempotent per run: re-settling the same runId (e.g. after a retry
   * that reuses the runId) replaces that run's ledger rows instead of appending,
   * so retry chains never double-count. Emits one deduplicated warning event per
   * newly crossed threshold and a budget.exhausted event at the hard limit. */
  settleRunCost(input: { runId: string; agentId: string; usage: RunUsage[] }) {
    return this.database.write((db) => {
      const now = Date.now();
      const agent = db.select().from(agents).where(eq(agents.id, input.agentId)).get();
      if (!agent) throw new IssueDomainError("not_found", `Agent ${input.agentId} not found`);
      // Spend attributable to every other run — the baseline this run adds to.
      const others = db.select().from(costEvents).where(eq(costEvents.agentId, input.agentId)).all()
        .filter((row) => row.runId !== input.runId);
      const baseline = others.reduce((total, row) => total + row.cost, 0);
      // Replace prior rows for this run so a re-settle is a pure overwrite.
      db.delete(costEvents).where(eq(costEvents.runId, input.runId)).run();
      const settled = settleUsage(input.usage);
      for (const row of settled) {
        db.insert(costEvents).values({
          id: randomUUID(), runId: input.runId, agentId: input.agentId, model: row.model,
          inputTokens: row.inputTokens, outputTokens: row.outputTokens, cost: row.cost, createdAt: now,
        }).run();
      }
      const runCost = settled.reduce((total, row) => total + row.cost, 0);
      const totalSpend = baseline + runCost;
      db.update(agents).set({ spentAmount: totalSpend, updatedAt: now }).where(eq(agents.id, input.agentId)).run();
      const crossings = this.emitBudgetWarnings(db, agent, baseline, totalSpend, input.runId, now);
      const status = budgetStatus(totalSpend, agent.budgetLimit);
      return { runCost, totalSpend, crossings, exhausted: status.exhausted, status };
    });
  }
  /** Deduplicated budget-warning / budget-exhausted events. Each threshold (and
   * the hard-stop marker 1.0) is recorded at most once per agent by checking the
   * activity log, so concurrent or replayed settlements never duplicate. */
  private emitBudgetWarnings(
    db: Parameters<Parameters<AppDatabase["write"]>[0]>[0], agent: AgentRow,
    previousSpend: number, newSpend: number, runId: string, now: number,
  ) {
    const limit = agent.budgetLimit;
    if (limit === null || !Number.isFinite(limit) || limit <= 0) return [] as number[];
    const emitted = new Set<number>(
      db.select().from(activityLog)
        .where(and(eq(activityLog.entityType, "agent"), eq(activityLog.entityId, agent.id))).all()
        .filter((event) => event.action === "budget.warning" || event.action === "budget.exhausted")
        .map((event) => (event.summary as { threshold?: number } | null)?.threshold)
        .filter((threshold): threshold is number => typeof threshold === "number"),
    );
    const marks = [...crossedThresholds(previousSpend, newSpend, limit)];
    if (budgetStatus(newSpend, limit).exhausted) marks.push(1);
    const fresh: number[] = [];
    for (const threshold of marks) {
      if (emitted.has(threshold)) continue;
      emitted.add(threshold);
      fresh.push(threshold);
      db.insert(activityLog).values({
        id: randomUUID(), actorType: "system", actorId: null,
        action: threshold >= 1 ? "budget.exhausted" : "budget.warning",
        entityType: "agent", entityId: agent.id,
        summary: { threshold, spent: newSpend, limit, runId }, runId, createdAt: now,
      }).run();
    }
    return fresh;
  }
  /** Ledger-derived spend for an agent (source of truth for budget checks). */
  agentSpend(agentId: string) {
    return this.database.read((db) =>
      db.select().from(costEvents).where(eq(costEvents.agentId, agentId)).all()
        .reduce((total, row) => total + row.cost, 0));
  }
  /** Budget status for an agent, spend derived from the ledger. */
  agentBudgetStatus(agentId: string) {
    return this.database.read((db) => {
      const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
      if (!agent) return null;
      const spend = db.select().from(costEvents).where(eq(costEvents.agentId, agentId)).all()
        .reduce((total, row) => total + row.cost, 0);
      return budgetStatus(spend, agent.budgetLimit);
    });
  }
  agentBudgetExhausted(agentId: string) {
    return this.agentBudgetStatus(agentId)?.exhausted ?? false;
  }
  /** Project-wide usage totals derived from the ledger (Dashboard surface). */
  projectUsage(projectId: string) {
    return this.database.read((db) => {
      const roster = db.select().from(agents).where(eq(agents.projectId, projectId)).all();
      const ids = new Set(roster.map((agent) => agent.id));
      const rows = roster.length
        ? db.select().from(costEvents).where(inArray(costEvents.agentId, [...ids])).all()
        : [];
      const spend = rows.reduce((total, row) => total + row.cost, 0);
      const inputTokens = rows.reduce((total, row) => total + row.inputTokens, 0);
      const outputTokens = rows.reduce((total, row) => total + row.outputTokens, 0);
      const budget = roster.reduce((total, agent) => total + (agent.budgetLimit ?? 0), 0);
      return {
        spend, inputTokens, outputTokens, events: rows.length,
        budget: budget > 0 ? budget : null,
        agents: roster.map((agent) => {
          const agentRows = rows.filter((row) => row.agentId === agent.id);
          const agentSpend = agentRows.reduce((total, row) => total + row.cost, 0);
          return { id: agent.id, name: agent.name, ...budgetStatus(agentSpend, agent.budgetLimit) };
        }),
      };
    });
  }
  appendActivity(input: Omit<typeof activityLog.$inferInsert, "id" | "createdAt">) {
    const row = { id: randomUUID(), createdAt: Date.now(), ...input };
    return this.database.write((db) => { db.insert(activityLog).values(row).run(); return row; });
  }
  listActivity(entityType: string, entityId: string) {
    return this.database.read((db) => db.select().from(activityLog).where(and(eq(activityLog.entityType, entityType), eq(activityLog.entityId, entityId))).orderBy(asc(activityLog.createdAt)).all());
  }
  /** Project-scoped append-only activity feed: every sensitive mutation whose
   * entity (issue, agent, or approval) belongs to the project, newest first.
   * Summaries are already redacted at write time. */
  listProjectActivity(projectId: string, limit = 200) {
    return this.database.read((db) => {
      const issueIds = db.select({ id: issues.id }).from(issues).where(eq(issues.projectId, projectId)).all().map((row) => row.id);
      const agentIds = db.select({ id: agents.id }).from(agents).where(eq(agents.projectId, projectId)).all().map((row) => row.id);
      const approvalIds = db.select({ id: approvals.id }).from(approvals).where(eq(approvals.projectId, projectId)).all().map((row) => row.id);
      const entityIds = [...new Set([...issueIds, ...agentIds, ...approvalIds])];
      if (!entityIds.length) return [];
      return db.select().from(activityLog).where(inArray(activityLog.entityId, entityIds)).orderBy(desc(activityLog.createdAt)).limit(limit).all();
    });
  }
}
