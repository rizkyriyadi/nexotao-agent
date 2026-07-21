import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "./database";
import {
  activityLog, agents, approvals, costEvents, documentRevisions, documents, heartbeatRuns,
  issueComments, issueDependencies, issueDocuments, issues, runEvents, wakeupRequests,
} from "./schema";
import { IssueDomainError, IssueLifecycleService } from "../issue-lifecycle";

export type NewAgent = typeof agents.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
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
      return { wakeup, heartbeat };
    });
  }
  claimNextHeartbeat(now = Date.now()): Promise<ClaimedHeartbeat | null> {
    return this.database.write((db) => {
      const candidates = db.select().from(wakeupRequests).where(eq(wakeupRequests.status, "queued"))
        .orderBy(asc(wakeupRequests.availableAt), asc(wakeupRequests.createdAt)).all().filter((row) => row.availableAt <= now);
      for (const candidate of candidates) {
        const agent = db.select().from(agents).where(eq(agents.id, candidate.agentId)).get();
        if (!agent || agent.status === "paused") continue;
        const configured = Number((agent.runtimeConfig as Record<string, unknown> | null)?.concurrency ?? 1);
        const concurrency = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 1;
        const active = db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, candidate.agentId), inArray(heartbeatRuns.status, ["running", "waiting"]))).all().length;
        if (active >= concurrency) continue;
        const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupId, candidate.id)).get();
        if (!heartbeat) continue;
        const runId = heartbeat.id;
        db.update(wakeupRequests).set({ status: "running", runId, claimedAt: now, attempt: candidate.attempt + 1, lastError: null }).where(eq(wakeupRequests.id, candidate.id)).run();
        db.update(heartbeatRuns).set({ status: "running", startedAt: now, updatedAt: now, finishedAt: null, error: null }).where(eq(heartbeatRuns.id, heartbeat.id)).run();
        return {
          wakeup: db.select().from(wakeupRequests).where(eq(wakeupRequests.id, candidate.id)).get()!,
          heartbeat: db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.id)).get()!,
        };
      }
      return null;
    });
  }
  transitionHeartbeat(runId: string, status: Exclude<HeartbeatStatus, "queued">, patch: {
    sessionBefore?: string | null; sessionAfter?: string | null; usage?: Record<string, unknown>; error?: string | null;
  } = {}) {
    return this.database.write((db) => {
      const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get();
      if (!heartbeat) return null;
      const now = Date.now();
      const terminal = ["succeeded", "failed", "cancelled"].includes(status);
      db.update(heartbeatRuns).set({ ...patch, status, updatedAt: now, finishedAt: terminal ? now : null }).where(eq(heartbeatRuns.id, runId)).run();
      if (heartbeat.wakeupId) db.update(wakeupRequests).set({ status: terminal ? status : "running", finishedAt: terminal ? now : null, lastError: patch.error ?? null }).where(eq(wakeupRequests.id, heartbeat.wakeupId)).run();
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
      }
      return orphaned.length;
    });
  }
  appendHeartbeatEvent(runId: string, type: string, redactedPayload: unknown) {
    return this.database.write((db) => {
      const last = db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(desc(runEvents.seq)).get();
      const row = { runId, seq: (last?.seq ?? 0) + 1, type, redactedPayload, createdAt: Date.now() };
      db.insert(runEvents).values(row).run();
      return row;
    });
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
    return this.database.write((db) => db.insert(runEvents).values(input).run());
  }
  listRunEvents(runId: string) {
    return this.database.read((db) => db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq)).all());
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
    return this.database.write((db) => { db.insert(approvals).values(row).run(); return row; });
  }
  listApprovals(issueId: string) {
    return this.database.read((db) => db.select().from(approvals).where(eq(approvals.issueId, issueId)).orderBy(asc(approvals.createdAt)).all());
  }
  addCost(input: Omit<typeof costEvents.$inferInsert, "id" | "createdAt">) {
    const row = { id: randomUUID(), createdAt: Date.now(), ...input };
    return this.database.write((db) => { db.insert(costEvents).values(row).run(); return row; });
  }
  appendActivity(input: Omit<typeof activityLog.$inferInsert, "id" | "createdAt">) {
    const row = { id: randomUUID(), createdAt: Date.now(), ...input };
    return this.database.write((db) => { db.insert(activityLog).values(row).run(); return row; });
  }
  listActivity(entityType: string, entityId: string) {
    return this.database.read((db) => db.select().from(activityLog).where(and(eq(activityLog.entityType, entityType), eq(activityLog.entityId, entityId))).orderBy(asc(activityLog.createdAt)).all());
  }
}
