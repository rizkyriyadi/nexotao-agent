import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "./database";
import {
  activityLog, agents, approvals, costEvents, documentRevisions, documents, heartbeatRuns,
  issueComments, issueDependencies, issueDocuments, issues, runEvents, wakeupRequests,
} from "./schema";

export type NewAgent = typeof agents.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type IssueRow = typeof issues.$inferSelect;

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
  checkoutIssue(issueId: string, runId: string) {
    return this.database.write((db) => {
      const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
      if (!issue || issue.checkoutRunId || ["in_progress", "done", "cancelled"].includes(issue.status)) return null;
      const dependencies = db.select().from(issueDependencies).where(eq(issueDependencies.issueId, issueId)).all();
      const blockers = dependencies.length
        ? db.select().from(issues).where(inArray(issues.id, dependencies.map((row) => row.blockerIssueId))).all()
        : [];
      if (blockers.some((row) => row.status !== "done")) return null;
      const now = Date.now();
      db.update(issues).set({ status: "in_progress", checkoutRunId: runId, executionLockedAt: now, startedAt: issue.startedAt ?? now, updatedAt: now })
        .where(eq(issues.id, issueId)).run();
      return db.select().from(issues).where(eq(issues.id, issueId)).get() ?? null;
    });
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
