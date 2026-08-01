import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "./db/database";
import { activityLog, agents, heartbeatRuns, issueDependencies, issueMutationRequests, issues, wakeupRequests } from "./db/schema";
import { isBlockerResolved } from "./blocker-attention";

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssueActor = { type: "agent" | "user" | "system"; id?: string | null; runId?: string | null };

const transitions: Record<IssueStatus, ReadonlySet<IssueStatus>> = {
  backlog: new Set(["todo", "blocked", "cancelled"]),
  todo: new Set(["backlog", "blocked", "cancelled"]),
  in_progress: new Set(["todo", "in_review", "blocked", "done", "cancelled"]),
  in_review: new Set(["todo", "done", "cancelled"]),
  blocked: new Set(["todo", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
};

/** Where `reopen` may take a task, by the status it is in now.
 *
 *  A second table rather than extra edges in the one above, because the two
 *  answer the same question for different authorities. `done` and `cancelled`
 *  are terminal in `transitions` and must stay that way: an agent that can
 *  un-finish its own work can loop on it forever. A person sending a follow-up
 *  is exactly the authority that may reopen, so the permission is written down
 *  here instead of being taken by writing around the table — which is what
 *  reopen used to do, leaving two disagreeing accounts of what may follow what
 *  and no way to tell which one the next reader would trust.
 *
 *  An empty set means "already live": the task is running, queued, or waiting on
 *  its blockers, and reopening it is a no-op beyond the run-mode change — the
 *  follow-up is carried by the run in flight or the wakeup already queued. */
const reopens: Record<IssueStatus, ReadonlySet<IssueStatus>> = {
  backlog: new Set(["todo", "blocked"]),
  todo: new Set(),
  in_progress: new Set(),
  blocked: new Set(),
  in_review: new Set(["todo", "blocked"]),
  done: new Set(["todo", "blocked"]),
  cancelled: new Set(["todo", "blocked"]),
};

export class IssueDomainError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid_transition" | "forbidden" | "invalid_dependency" | "validation", message: string) {
    super(message);
    this.name = "IssueDomainError";
  }
}

type Db = AppDatabase["orm"];
type IssueRow = typeof issues.$inferSelect;

function statusOf(row: IssueRow): IssueStatus {
  if (!(ISSUE_STATUSES as readonly string[]).includes(row.status)) throw new IssueDomainError("invalid_transition", `Unknown issue status: ${row.status}`);
  return row.status as IssueStatus;
}

function audit(db: Db, input: { actor: IssueActor; action: string; issueId: string; summary: unknown; now: number; runId?: string | null }) {
  db.insert(activityLog).values({
    id: randomUUID(), actorType: input.actor.type, actorId: input.actor.id ?? null, action: input.action,
    entityType: "issue", entityId: input.issueId, summary: input.summary, runId: input.runId ?? input.actor.runId ?? null, createdAt: input.now,
  }).run();
}

function blockers(db: Db, issueId: string) {
  const dependencies = db.select().from(issueDependencies).where(eq(issueDependencies.issueId, issueId)).all();
  return dependencies.length
    ? db.select().from(issues).where(inArray(issues.id, dependencies.map((dependency) => dependency.blockerIssueId))).all()
    : [];
}

/** A blocker stops holding its dependents once it reaches a terminal state.
 *  `cancelled` counts as resolved as well as `done`: treating it as unmet made a
 *  cancelled blocker deadlock its dependents forever, because nothing wakes them
 *  and `blocked → todo` is rejected while blockers are unmet. The dependent is
 *  freed here and flagged for attention by `computeBlockerAttention`, which is
 *  where "a cancelled blocker still needs a decision" is surfaced. */
function hasUnmetBlockers(db: Db, issueId: string) {
  return blockers(db, issueId).some((blocker) => !isBlockerResolved(blocker.status));
}

function enqueue(db: Db, input: { agentId: string; issueId: string; reason: string; key: string; now: number }) {
  const existing = db.select().from(wakeupRequests).where(and(
    eq(wakeupRequests.agentId, input.agentId), eq(wakeupRequests.idempotencyKey, input.key),
  )).get();
  if (existing) return;
  const wakeupId = randomUUID();
  db.insert(wakeupRequests).values({
    id: wakeupId, agentId: input.agentId, issueId: input.issueId, reason: input.reason,
    idempotencyKey: input.key, status: "queued", availableAt: input.now, runId: null, attempt: 0,
    claimedAt: null, finishedAt: null, lastError: null, createdAt: input.now,
  }).run();
  db.insert(heartbeatRuns).values({
    id: randomUUID(), agentId: input.agentId, issueId: input.issueId, wakeupId, source: input.reason,
    status: "queued", usage: {}, queuedAt: input.now, startedAt: input.now, updatedAt: input.now,
  }).run();
}

function ensureAgent(db: Db, projectId: string, agentId: string) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || agent.projectId !== projectId) throw new IssueDomainError("forbidden", "Assignee must be an agent in the issue project");
  return agent;
}

function createsDependencyCycle(db: Db, issueId: string, blockerIssueId: string) {
  const pending = [blockerIssueId];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === issueId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const next = db.select().from(issueDependencies).where(eq(issueDependencies.issueId, current)).all();
    pending.push(...next.map((row) => row.blockerIssueId));
  }
  return false;
}

function validateDependencies(db: Db, issue: Pick<IssueRow, "id" | "projectId">, blockerIds: string[]) {
  for (const blockerId of blockerIds) {
    if (blockerId === issue.id) throw new IssueDomainError("invalid_dependency", "An issue cannot block itself");
    const blocker = db.select().from(issues).where(eq(issues.id, blockerId)).get();
    if (!blocker || blocker.projectId !== issue.projectId) throw new IssueDomainError("invalid_dependency", "Blockers must exist in the same project");
    if (createsDependencyCycle(db, issue.id, blockerId)) throw new IssueDomainError("invalid_dependency", "Issue dependencies cannot contain cycles");
  }
}

function validateParent(db: Db, issue: Pick<IssueRow, "id" | "projectId">, parentId: string | null) {
  if (parentId === null) return;
  if (parentId === issue.id) throw new IssueDomainError("validation", "An issue cannot be its own parent");
  const parent = db.select().from(issues).where(eq(issues.id, parentId)).get();
  if (!parent || parent.projectId !== issue.projectId) throw new IssueDomainError("not_found", "Parent issue was not found in this project");
  // Walk up from the proposed parent. `create` validates the parent exists but
  // nothing validated a *re-parent*, so a sub-task could be made the parent of
  // its own ancestor — a cycle every tree walk in the app then follows forever.
  const seen = new Set<string>();
  let cursor: string | null = parent.parentId;
  while (cursor) {
    if (cursor === issue.id) throw new IssueDomainError("validation", "Issue hierarchy cannot contain cycles");
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = db.select().from(issues).where(eq(issues.id, cursor)).get()?.parentId ?? null;
  }
}

/* The three mutations below are written as plain functions over an open
   transaction rather than as methods that each open their own. An edit that
   changes several of these at once has to be one write — see `edit` — and the
   only way to have that and the standalone entry points too is for the body to
   be independent of who opened the transaction. */

function applyAssign(db: Db, issueId: string, assigneeAgentId: string | null, actor: IssueActor, now: number) {
  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) throw new IssueDomainError("not_found", "Issue not found");
  if (assigneeAgentId) ensureAgent(db, issue.projectId, assigneeAgentId);
  if (issue.assigneeAgentId === assigneeAgentId) return issue;
  const previous = issue.assigneeAgentId;
  const interruptedRunId = issue.checkoutRunId;
  const status = issue.checkoutRunId ? (hasUnmetBlockers(db, issue.id) ? "blocked" : "todo") : issue.status;
  db.update(issues).set({ assigneeAgentId, status, checkoutRunId: null, executionLockedAt: null, updatedAt: now }).where(eq(issues.id, issue.id)).run();
  audit(db, { actor, action: "issue.assigned", issueId, summary: { from: previous, to: assigneeAgentId, interruptedRunId }, now, runId: interruptedRunId });
  if (assigneeAgentId && status === "todo" && !hasUnmetBlockers(db, issueId)) enqueue(db, {
    agentId: assigneeAgentId, issueId, reason: "assignment",
    key: `assignment:${issueId}:${assigneeAgentId}:${now}`, now,
  });
  return db.select().from(issues).where(eq(issues.id, issueId)).get()!;
}

function applyDependencies(db: Db, issueId: string, blockerIds: string[], actor: IssueActor, now: number) {
  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) throw new IssueDomainError("not_found", "Issue not found");
  const unique = [...new Set(blockerIds)].sort();
  validateDependencies(db, issue, unique);
  db.delete(issueDependencies).where(eq(issueDependencies.issueId, issueId)).run();
  for (const blockerIssueId of unique) db.insert(issueDependencies).values({ issueId, blockerIssueId, createdAt: now }).run();
  const unmet = hasUnmetBlockers(db, issueId);
  let status = issue.status;
  const interruptedRunId = unmet && status === "in_progress" ? issue.checkoutRunId : null;
  if (unmet && (status === "todo" || status === "backlog" || status === "in_progress")) status = "blocked";
  if (!unmet && status === "blocked") status = "todo";
  db.update(issues).set({
    status, updatedAt: now,
    ...(interruptedRunId ? { checkoutRunId: null, executionLockedAt: null } : {}),
  }).where(eq(issues.id, issueId)).run();
  audit(db, { actor, action: "issue.dependencies_updated", issueId, summary: { blockerIds: unique, fromStatus: issue.status, toStatus: status, interruptedRunId }, now });
  if (interruptedRunId) audit(db, {
    actor, action: "issue.released", issueId, summary: { from: "in_progress", to: "blocked", reason: "blocker_added" }, now, runId: interruptedRunId,
  });
  if (!unmet && status === "todo" && issue.assigneeAgentId) enqueue(db, {
    agentId: issue.assigneeAgentId, issueId, reason: "dependency", key: `dependencies-set:${issueId}:${now}`, now,
  });
  return db.select().from(issues).where(eq(issues.id, issueId)).get()!;
}

function applyTransition(db: Db, issueId: string, target: Exclude<IssueStatus, "in_progress">, actor: IssueActor, now: number) {
  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) throw new IssueDomainError("not_found", "Issue not found");
  const current = statusOf(issue);
  if (current === target) return issue;
  if (!transitions[current].has(target)) throw new IssueDomainError("invalid_transition", `Cannot transition issue from ${current} to ${target}`);
  if (target === "todo" && hasUnmetBlockers(db, issue.id)) throw new IssueDomainError("invalid_transition", "Blocked issues cannot become runnable until every blocker is done");
  if (target === "blocked" && !hasUnmetBlockers(db, issue.id)) throw new IssueDomainError("invalid_transition", "Issue has no unresolved blockers");
  if (current === "in_progress" && actor.type === "agent") {
    if (actor.id !== issue.assigneeAgentId) throw new IssueDomainError("forbidden", "Only the assigned agent can transition checked-out work");
    if (actor.runId && actor.runId !== issue.checkoutRunId) throw new IssueDomainError("conflict", "Run does not own this issue checkout");
  }
  const patch: Partial<typeof issues.$inferInsert> = {
    status: target, checkoutRunId: null, executionLockedAt: null, updatedAt: now,
    ...(target === "done" ? { completedAt: now } : {}),
    ...(target === "cancelled" ? { cancelledAt: now } : {}),
  };
  db.update(issues).set(patch).where(eq(issues.id, issue.id)).run();
  audit(db, { actor, action: "issue.transitioned", issueId, summary: { from: current, to: target }, now, runId: issue.checkoutRunId });
  const updated = db.select().from(issues).where(eq(issues.id, issue.id)).get()!;
  // Cancelling releases dependents just like completing does. Without this a
  // cancelled blocker leaves every dependent stuck in `blocked` with no path
  // out, since only this call can demote them back to `todo`.
  if (isBlockerResolved(target)) wakeDependents(db, updated, actor, now);
  return updated;
}

function wakeDependents(db: Db, completed: IssueRow, actor: IssueActor, now: number) {
  const dependentLinks = db.select().from(issueDependencies).where(eq(issueDependencies.blockerIssueId, completed.id)).all();
  for (const link of dependentLinks.sort((a, b) => a.issueId.localeCompare(b.issueId))) {
    const dependent = db.select().from(issues).where(eq(issues.id, link.issueId)).get();
    if (!dependent || hasUnmetBlockers(db, dependent.id)) continue;
    let eligible = dependent;
    if (dependent.status === "blocked") {
      db.update(issues).set({ status: "todo", updatedAt: now }).where(eq(issues.id, dependent.id)).run();
      eligible = { ...dependent, status: "todo", updatedAt: now };
      audit(db, { actor, action: "issue.transitioned", issueId: dependent.id, summary: { from: "blocked", to: "todo", reason: "blockers_resolved" }, now });
    }
    if (eligible.status === "todo" && eligible.assigneeAgentId) {
      enqueue(db, {
        agentId: eligible.assigneeAgentId, issueId: eligible.id, reason: "dependency",
        key: `dependencies-resolved:${eligible.id}:${completed.id}:${now}`, now,
      });
    }
  }
}

export class IssueLifecycleService {
  constructor(private readonly database: AppDatabase) {}

  create(input: {
    projectId: string; title: string; description?: string; parentId?: string | null; assigneeAgentId?: string | null;
    status?: IssueStatus; stage?: string; priority?: string; runMode?: string; blockerIds?: string[];
    idempotencyKey?: string; actor?: IssueActor; now?: number;
  }) {
    return this.database.write((db) => {
      const now = input.now ?? Date.now();
      const actor = input.actor ?? { type: "system" as const };
      const operation = "create" as const;
      const blockerIds = [...new Set(input.blockerIds ?? [])].sort();
      const normalized = {
        title: input.title.trim() || "Untitled", description: input.description ?? "", parentId: input.parentId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        status: input.status ?? "todo", stage: input.stage ?? "execute", priority: input.priority ?? "medium",
        runMode: input.runMode ?? "agent", blockerIds,
      };
      const fingerprint = JSON.stringify(normalized);
      if (input.idempotencyKey) {
        const prior = db.select().from(issueMutationRequests).where(and(
          eq(issueMutationRequests.projectId, input.projectId), eq(issueMutationRequests.operation, operation),
          eq(issueMutationRequests.idempotencyKey, input.idempotencyKey),
        )).get();
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new IssueDomainError("conflict", "Idempotency key was already used with a different request");
          return db.select().from(issues).where(eq(issues.id, prior.issueId)).get()!;
        }
      }
      if (normalized.assigneeAgentId) ensureAgent(db, input.projectId, normalized.assigneeAgentId);
      if (normalized.parentId) validateParent(db, { id: "", projectId: input.projectId }, normalized.parentId);
      const all = db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.projectId, input.projectId)).all();
      const next = all.reduce((highest, row) => Math.max(highest, Number(row.identifier.match(/-(\d+)$/)?.[1] ?? 0)), 0) + 1;
      const id = randomUUID();
      validateDependencies(db, { id, projectId: input.projectId }, blockerIds);
      const unresolved = blockerIds.some((blockerId) => !isBlockerResolved(db.select().from(issues).where(eq(issues.id, blockerId)).get()?.status ?? ""));
      const requestedStatus = normalized.status;
      // Blocked is derived from unmet blockers regardless of the status asked
      // for, so a task parked in `backlog` with blockers reads as blocked rather
      // than silently pretending it is merely unscheduled.
      const status = unresolved && (requestedStatus === "todo" || requestedStatus === "backlog") ? "blocked" : requestedStatus;
      if (status === "in_progress") throw new IssueDomainError("invalid_transition", "Issues enter in_progress only through checkout");
      const row = {
        id, projectId: input.projectId, identifier: `NX-${next}`, parentId: normalized.parentId, title: normalized.title,
        description: normalized.description, status, stage: normalized.stage, priority: normalized.priority, runMode: normalized.runMode,
        assigneeAgentId: normalized.assigneeAgentId, summary: "", createdAt: now, updatedAt: now,
      };
      db.insert(issues).values(row).run();
      for (const blockerIssueId of blockerIds) db.insert(issueDependencies).values({ issueId: id, blockerIssueId, createdAt: now }).run();
      if (input.idempotencyKey) db.insert(issueMutationRequests).values({
        id: randomUUID(), projectId: input.projectId, operation, idempotencyKey: input.idempotencyKey,
        fingerprint, issueId: id, createdAt: now,
      }).run();
      audit(db, { actor, action: "issue.created", issueId: id, summary: { status, parentId: normalized.parentId }, now });
      if (normalized.assigneeAgentId && status === "todo") enqueue(db, {
        agentId: normalized.assigneeAgentId, issueId: id, reason: "assignment",
        key: `assignment:${id}:${normalized.assigneeAgentId}:created`, now,
      });
      return db.select().from(issues).where(eq(issues.id, id)).get()!;
    });
  }

  assign(issueId: string, assigneeAgentId: string | null, actor: IssueActor, now = Date.now()) {
    return this.database.write((db) => applyAssign(db, issueId, assigneeAgentId, actor, now));
  }

  setDependencies(issueId: string, blockerIds: string[], actor: IssueActor, now = Date.now()) {
    return this.database.write((db) => applyDependencies(db, issueId, blockerIds, actor, now));
  }

  transition(issueId: string, target: Exclude<IssueStatus, "in_progress">, actor: IssueActor, now = Date.now()) {
    return this.database.write((db) => applyTransition(db, issueId, target, actor, now));
  }

  /**
   * Apply a whole edit — fields, assignee, blockers, status — as one
   * transaction, so a rejected part rejects the rest with it.
   *
   * The caller used to make these calls one after another, each opening its own
   * write. A rename that came with an illegal status change committed the rename
   * and then threw, so the user got a half-applied edit and an error describing
   * the half that failed; and an editor reading the row between the two saw a
   * state neither side had asked for. Ordering inside the transaction is
   * deliberate: fields first, then assignee, then blockers, then status, so the
   * status check sees the blockers this same edit is adding rather than the ones
   * that were there before it.
   */
  edit(input: {
    issueId: string;
    fields?: { title?: string; description?: string; parentId?: string | null; stage?: string; priority?: string; runMode?: string; model?: string | null; summary?: string };
    assigneeAgentId?: string | null;
    blockerIds?: string[];
    status?: Exclude<IssueStatus, "in_progress">;
    actor: IssueActor;
    now?: number;
  }) {
    return this.database.write((db) => {
      const now = input.now ?? Date.now();
      const issue = db.select().from(issues).where(eq(issues.id, input.issueId)).get();
      if (!issue) throw new IssueDomainError("not_found", "Issue not found");
      const fields = input.fields ?? {};
      if (fields.parentId !== undefined && fields.parentId !== issue.parentId) validateParent(db, issue, fields.parentId);
      if (Object.keys(fields).length) {
        db.update(issues).set({ ...fields, updatedAt: now }).where(eq(issues.id, issue.id)).run();
      }
      if (input.assigneeAgentId !== undefined) applyAssign(db, input.issueId, input.assigneeAgentId, input.actor, now);
      if (input.blockerIds !== undefined) applyDependencies(db, input.issueId, input.blockerIds, input.actor, now);
      // Read the status back rather than comparing against the one this edit
      // started with: assigning or blocking may have moved it already, and
      // asking the table for an edge that is now a no-op would reject an edit
      // that has in fact arrived exactly where it was going.
      const current = db.select().from(issues).where(eq(issues.id, issue.id)).get()!.status;
      // `todo` and `blocked` are not chosen, they are derived from whether any
      // blocker is outstanding — and `applyDependencies` above has just derived
      // them from the blockers this same edit set. So an edit that moves a task
      // to Todo *and* gives it a blocker is not a contradiction to refuse; it is
      // one the blockers have already answered.
      const derived = input.blockerIds !== undefined
        && (current === "todo" || current === "blocked")
        && (input.status === "todo" || input.status === "blocked");
      if (input.status !== undefined && input.status !== current && !derived) {
        if ((input.status as string) === "in_progress") throw new IssueDomainError("invalid_transition", "Issues enter in_progress only through checkout");
        applyTransition(db, input.issueId, input.status, input.actor, now);
      }
      return db.select().from(issues).where(eq(issues.id, issue.id)).get()!;
    });
  }

  checkout(issueId: string, agentId: string, runId: string, now = Date.now()) {
    return this.database.write((db) => {
      const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
      if (!issue) throw new IssueDomainError("not_found", "Issue not found");
      if (issue.checkoutRunId === runId && issue.assigneeAgentId === agentId && issue.status === "in_progress") return issue;
      if (issue.assigneeAgentId !== agentId) throw new IssueDomainError("forbidden", "Only the assigned agent can check out this issue");
      if (issue.status !== "todo" || issue.checkoutRunId) throw new IssueDomainError("conflict", "Issue is not available for checkout");
      if (hasUnmetBlockers(db, issue.id)) throw new IssueDomainError("conflict", "Issue still has unresolved blockers");
      const duplicateRun = db.select().from(issues).where(eq(issues.checkoutRunId, runId)).get();
      if (duplicateRun) throw new IssueDomainError("conflict", "Run already owns another issue checkout");
      db.update(issues).set({ status: "in_progress", checkoutRunId: runId, executionLockedAt: now, startedAt: issue.startedAt ?? now, updatedAt: now })
        .where(eq(issues.id, issueId)).run();
      audit(db, { actor: { type: "agent", id: agentId, runId }, action: "issue.checked_out", issueId, summary: { from: issue.status, to: "in_progress" }, now });
      return db.select().from(issues).where(eq(issues.id, issueId)).get()!;
    });
  }

  release(input: { issueId: string; agentId: string; runId: string; reason?: string; now?: number }) {
    return this.database.write((db) => {
      const now = input.now ?? Date.now();
      const issue = db.select().from(issues).where(eq(issues.id, input.issueId)).get();
      if (!issue) throw new IssueDomainError("not_found", "Issue not found");
      if (issue.assigneeAgentId !== input.agentId) throw new IssueDomainError("forbidden", "Only the assigned agent can release this issue");
      if (issue.checkoutRunId !== input.runId || issue.status !== "in_progress") throw new IssueDomainError("conflict", "Run does not own this issue checkout");
      const status = hasUnmetBlockers(db, issue.id) ? "blocked" : "todo";
      db.update(issues).set({ status, checkoutRunId: null, executionLockedAt: null, updatedAt: now }).where(eq(issues.id, issue.id)).run();
      audit(db, { actor: { type: "agent", id: input.agentId, runId: input.runId }, action: "issue.released", issueId: issue.id, summary: { from: "in_progress", to: status, reason: input.reason ?? "released" }, now });
      return db.select().from(issues).where(eq(issues.id, issue.id)).get()!;
    });
  }

  /**
   * Reopen a finished (or paused) task so its assignee runs again on the same
   * issue — this is how a follow-up message continues the conversation. A task
   * already executing is left alone (the follow-up is picked up by the queued
   * wakeup once the current run finishes). Optionally switches the run mode.
   *
   * The destination is checked against `reopens`, not written straight to the
   * row. That table is the only place reopening is permitted at all, and it is
   * deliberately narrower than the free-for-all this used to be: a status it
   * does not name is a status nobody has decided the meaning of reopening for,
   * and guessing there is how work comes back from a state that had already
   * released its checkout lock, its undo point, or its dependents.
   */
  reopen(issueId: string, actor: IssueActor, runMode?: string, now = Date.now()) {
    return this.database.write((db) => {
      const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
      if (!issue) throw new IssueDomainError("not_found", "Issue not found");
      const current = statusOf(issue);
      const target = hasUnmetBlockers(db, issue.id) ? "blocked" : "todo";
      const modePatch = runMode ? { runMode } : {};
      // Already live — the run in flight or the wakeup already queued carries
      // the follow-up, so only the mode changes.
      if (!reopens[current].size) {
        db.update(issues).set({ ...modePatch, updatedAt: now }).where(eq(issues.id, issue.id)).run();
        return db.select().from(issues).where(eq(issues.id, issue.id)).get()!;
      }
      if (!reopens[current].has(target)) throw new IssueDomainError("invalid_transition", `Cannot reopen issue from ${current} to ${target}`);
      db.update(issues).set({
        ...modePatch, status: target, checkoutRunId: null, executionLockedAt: null,
        // Cleared together with the status: a task that is runnable again but
        // still carries the timestamp of the day it finished reads as done to
        // every list that sorts or filters on completion.
        completedAt: null, cancelledAt: null, updatedAt: now,
      }).where(eq(issues.id, issue.id)).run();
      audit(db, { actor, action: "issue.reopened", issueId, summary: { from: current, to: target }, now });
      // The caller (executor.tick) enqueues the wakeup for the now-runnable task.
      return db.select().from(issues).where(eq(issues.id, issue.id)).get()!;
    });
  }

  recover(input: { staleAfterMs: number; now?: number; activeRunIds?: Iterable<string>; actor?: IssueActor }) {
    return this.database.write((db) => {
      const now = input.now ?? Date.now();
      const cutoff = now - input.staleAfterMs;
      const active = new Set(input.activeRunIds ?? []);
      const locked = db.select().from(issues).where(eq(issues.status, "in_progress")).orderBy(asc(issues.id)).all();
      const recovered: IssueRow[] = [];
      for (const issue of locked) {
        if (!issue.checkoutRunId || active.has(issue.checkoutRunId)) continue;
        if (issue.executionLockedAt !== null && issue.executionLockedAt > cutoff) continue;
        const status = hasUnmetBlockers(db, issue.id) ? "blocked" : "todo";
        db.update(issues).set({ status, checkoutRunId: null, executionLockedAt: null, updatedAt: now }).where(eq(issues.id, issue.id)).run();
        audit(db, {
          actor: input.actor ?? { type: "system" }, action: "issue.recovered", issueId: issue.id,
          summary: { from: "in_progress", to: status, staleRunId: issue.checkoutRunId }, now, runId: issue.checkoutRunId,
        });
        const updated = db.select().from(issues).where(eq(issues.id, issue.id)).get()!;
        recovered.push(updated);
        if (status === "todo" && issue.assigneeAgentId) enqueue(db, {
          agentId: issue.assigneeAgentId, issueId: issue.id, reason: "retry",
          key: `recovery:${issue.id}:${issue.checkoutRunId}`, now,
        });
      }
      return recovered;
    });
  }
}
