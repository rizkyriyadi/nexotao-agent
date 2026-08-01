import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { AppDatabase } from "./database";
import {
  activityLog, agents, approvals, documentRevisions, documents, heartbeatRuns,
  issueComments, issueDependencies, issueDocuments, issues, runEvents, wakeupRequests,
} from "./schema";
import { IssueDomainError, IssueLifecycleService } from "../issue-lifecycle";
import {
  isTerminalRunEvent, publishRunEvent, RunEventDomainError, sanitizeRunEventPayload,
  type DurableRunEvent,
} from "../run-events";

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
/** Statuses a human chose and only a human clears. Notably *not* `error`: that
 *  one is set by whichever task happened to fail last, so treating it as a gate
 *  would let a single failure strand the agent's entire queue. */
export const HUMAN_GATED_AGENT_STATUS = ["paused", "terminated"];

/** How many times one wakeup may be claimed before the queue gives up on it.
 *
 *  `attempt` was incremented on every claim and read by nothing, so a run that
 *  took the server down with it was requeued by boot recovery, claimed again,
 *  and took the server down again — indefinitely, with no surface anywhere
 *  saying why. Four is enough to ride out a transient fault (a locked file, a
 *  network blip) and few enough that a genuinely poisonous run stops mattering
 *  within one restart cycle rather than never. */
export const MAX_WAKEUP_ATTEMPTS = 4;

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
  /** Cancelling a run must release its issue even when the in-memory `Run` is
   * gone — after a restart, after the run-manager GC, or when the cancel is
   * served by a different worker than the one executing. Without this the issue
   * stays `in_progress` forever and every surface keeps rendering a spinner. */
  async cancelRunIssue(runId: string) {
    const issueId = this.getHeartbeat(runId)?.issueId;
    if (!issueId) return null;
    const issue = this.issues.get(issueId);
    if (!issue) return null;
    if (issue.status === "cancelled") return issue; // already released — cancel twice is a no-op
    // Only the checkout this run holds is released. A run cancelled before it
    // checked out owns nothing (the task stays runnable, which is what pausing
    // an agent means), and a newer run's checkout belongs to the work that
    // replaced this one.
    if (issue.status !== "in_progress" || issue.checkoutRunId !== runId) return null;
    try {
      return await new IssueLifecycleService(this.database).transition(issueId, "cancelled", { type: "system", runId });
    } catch (error) {
      if (error instanceof IssueDomainError && ["invalid_transition", "conflict", "not_found"].includes(error.code)) return null;
      throw error;
    }
  }
  /** Boot-time counterpart to `recoverOrphanedHeartbeats`: requeueing the wakeup
   * is not enough, because an issue whose run already reached a terminal state
   * stays checked out to it and renders as running forever. A requeued orphan
   * keeps its checkout — `checkout` is idempotent for its own run id — so only
   * issues whose run is gone for good are released. */
  recoverStaleIssues(staleAfterMs = 0, now = Date.now()) {
    const live = this.database.read((db) => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running", "waiting"])).all());
    return new IssueLifecycleService(this.database).recover({ staleAfterMs, now, activeRunIds: live.map((row) => row.id) });
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
      // `paused` and `terminated` are human decisions and must survive new work.
      // `error` is not: it is the residue of one task that failed. Latching it
      // would strand every *other* task assigned to this agent, silently.
      if (agent && !HUMAN_GATED_AGENT_STATUS.includes(agent.status)) {
        db.update(agents).set({ status: "queued", errorReason: null, updatedAt: now }).where(eq(agents.id, input.agentId)).run();
      }
      return { wakeup, heartbeat };
    });
  }
  /** Remember where a run's safety net lives, so Revert survives a restart.
   *
   *  Best effort by design: a run whose snapshot never captured is still a
   *  perfectly good run, it simply has nothing to offer Revert. */
  recordSnapshot(runId: string, snapshotCommit: string, snapshotHead: string | null) {
    return this.database.write((db) => {
      db.update(heartbeatRuns).set({ snapshotCommit, snapshotHead, updatedAt: Date.now() }).where(eq(heartbeatRuns.id, runId)).run();
      return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get() ?? null;
    });
  }
  /** Forget a run's safety net, once the ref behind it is gone.
   *
   *  Always paired with `dropSnapshot`: the ref is what keeps the commit
   *  reachable, so a row still naming it after the ref is deleted would offer a
   *  Revert that resolves to nothing the next time git runs its own gc. */
  clearSnapshot(runId: string) {
    return this.database.write((db) => {
      db.update(heartbeatRuns).set({ snapshotCommit: null, snapshotHead: null, updatedAt: Date.now() })
        .where(eq(heartbeatRuns.id, runId)).run();
    });
  }
  /** The newest run on this issue that has a snapshot — the one Revert is
   *  offered against. Newest wins: a follow-up run's snapshot records the folder
   *  as the earlier run left it, so reverting to it undoes only the latest work,
   *  which is what the button beside it claims to do. */
  latestSnapshotForIssue(issueId: string) {
    return this.database.read((db) => db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.issueId, issueId)).orderBy(desc(heartbeatRuns.startedAt)).all()
      .find((row) => row.snapshotCommit) ?? null);
  }
  /** Runs whose snapshot must not be swept: their task is still parked in
   *  review, so the button is still on offer. */
  snapshotRunIdsInReview(projectId?: string) {
    return this.database.read((db) => {
      const parked = db.select().from(issues)
        .where(projectId ? and(eq(issues.projectId, projectId), eq(issues.status, "in_review")) : eq(issues.status, "in_review")).all();
      const held = new Set<string>();
      for (const issue of parked) {
        for (const run of db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id)).all()) {
          if (run.snapshotCommit) held.add(run.id);
        }
      }
      return held;
    });
  }
  /** Retire queued wakeups that have already been claimed too many times, before
   *  anything can claim them again.
   *
   *  This is the only thing standing between a run that kills the process and an
   *  endless crash loop: boot recovery requeues whatever was `running`, so
   *  without a ceiling the same poisonous run is picked up on every start. Runs
   *  retired here end in a terminal `failure` event, which is what makes them
   *  visible in the transcript instead of silently vanishing from the queue. */
  async abandonExhaustedHeartbeats(now = Date.now(), maxAttempts = MAX_WAKEUP_ATTEMPTS) {
    const abandoned = await this.database.write((db) => {
      const exhausted = db.select().from(wakeupRequests).where(eq(wakeupRequests.status, "queued")).all()
        .filter((row) => row.attempt >= maxAttempts);
      const events: DurableRunEvent[] = [];
      const retired: Array<{ runId: string; reason: string }> = [];
      for (const wakeup of exhausted) {
        const reason = `Gave up after ${wakeup.attempt} attempts${wakeup.lastError ? `: ${wakeup.lastError}` : ""}`;
        const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupId, wakeup.id)).get();
        if (heartbeat) retired.push({ runId: heartbeat.id, reason });
        db.update(wakeupRequests).set({ status: "failed", finishedAt: now, lastError: reason }).where(eq(wakeupRequests.id, wakeup.id)).run();
        if (heartbeat) {
          db.update(heartbeatRuns).set({ status: "failed", error: reason, updatedAt: now, finishedAt: now }).where(eq(heartbeatRuns.id, heartbeat.id)).run();
          const last = db.select().from(runEvents).where(eq(runEvents.runId, heartbeat.id)).orderBy(desc(runEvents.seq)).get();
          if (!last || !isTerminalRunEvent(last.type)) {
            const event = {
              runId: heartbeat.id, seq: (last?.seq ?? 0) + 1, type: "failure",
              redactedPayload: sanitizeRunEventPayload({ status: "failed", error: reason }), createdAt: now,
            };
            db.insert(runEvents).values(event).run();
            events.push(event);
          }
        }
        const agent = db.select().from(agents).where(eq(agents.id, wakeup.agentId)).get();
        if (agent && !HUMAN_GATED_AGENT_STATUS.includes(agent.status)) {
          db.update(agents).set({ status: "error", errorReason: reason, updatedAt: now }).where(eq(agents.id, wakeup.agentId)).run();
        }
        db.insert(activityLog).values({
          id: randomUUID(), actorType: "system", actorId: null, action: "heartbeat.abandoned",
          entityType: "agent", entityId: wakeup.agentId, summary: { wakeupId: wakeup.id, attempts: wakeup.attempt, reason },
          runId: heartbeat?.id ?? null, createdAt: now,
        }).run();
      }
      return { events, retired, count: exhausted.length };
    });
    for (const event of abandoned.events) publishRunEvent(event);
    // Outside the transaction: the lifecycle opens its own write, and an issue
    // still checked out to a retired run would otherwise render as running for
    // good — the very state this whole path exists to escape.
    for (const { runId } of abandoned.retired) await this.failRunIssue(runId).catch(() => null);
    return abandoned.count;
  }
  /** Send an issue whose run was retired to review rather than leaving it checked
   *  out. `in_review` is the honest destination: the work stopped partway and a
   *  human has to decide what happens next. */
  private async failRunIssue(runId: string) {
    const issueId = this.getHeartbeat(runId)?.issueId;
    if (!issueId) return null;
    const issue = this.issues.get(issueId);
    if (!issue || issue.status !== "in_progress" || issue.checkoutRunId !== runId) return null;
    try {
      return await new IssueLifecycleService(this.database).transition(issueId, "in_review", { type: "system", runId });
    } catch (error) {
      if (error instanceof IssueDomainError && ["invalid_transition", "conflict", "not_found"].includes(error.code)) return null;
      throw error;
    }
  }
  claimNextHeartbeat(now = Date.now()): Promise<ClaimedHeartbeat | null> {
    return this.database.write((db) => {
      const candidates = db.select().from(wakeupRequests).where(eq(wakeupRequests.status, "queued"))
        .orderBy(asc(wakeupRequests.availableAt), asc(wakeupRequests.createdAt)).all().filter((row) => row.availableAt <= now);
      for (const candidate of candidates) {
        // Belt to abandonExhaustedHeartbeats' braces: whatever else requeues a
        // wakeup, nothing gets to claim one that has already used up its budget.
        if (candidate.attempt >= MAX_WAKEUP_ATTEMPTS) continue;
        const agent = db.select().from(agents).where(eq(agents.id, candidate.agentId)).get();
        // Only a human-gated status blocks the claim. An agent left in `error` by
        // a previous failure still picks up the next task — otherwise one bad run
        // wedges the queue forever and the work just sits there looking queued.
        if (!agent || HUMAN_GATED_AGENT_STATUS.includes(agent.status)) continue;
        // One run at a time per agent. A second concurrent run would have the two
        // sharing a workspace and a session, so the queue holds the next wakeup
        // until the current one finishes rather than interleaving them.
        const active = db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, candidate.agentId), inArray(heartbeatRuns.status, ["running", "waiting"]))).all().length;
        if (active >= 1) continue;
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
  /** Put a run back on the queue. `resetAttempts` distinguishes the two callers:
   *  a person clicking retry has usually changed something and deserves a fresh
   *  budget, while an automatic requeue must keep counting toward the ceiling or
   *  the ceiling means nothing. */
  requeueHeartbeat(runId: string, availableAt: number, error?: string, resetAttempts = false) {
    return this.database.write((db) => {
      const heartbeat = db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).get();
      if (!heartbeat?.wakeupId) return false;
      const now = Date.now();
      db.update(heartbeatRuns).set({ status: "queued", error: error ?? null, updatedAt: now, finishedAt: null }).where(eq(heartbeatRuns.id, runId)).run();
      db.update(wakeupRequests).set({
        status: "queued", availableAt, runId: null, claimedAt: null, finishedAt: null, lastError: error ?? null,
        ...(resetAttempts ? { attempt: 0 } : {}),
      }).where(eq(wakeupRequests.id, heartbeat.wakeupId)).run();
      db.update(agents).set({ status: "queued", errorReason: null, updatedAt: now }).where(eq(agents.id, heartbeat.agentId)).run();
      return true;
    });
  }
  /** Requeue whatever was mid-flight when the process died. The attempt counter
   *  is deliberately left where the claim put it: a run that crashes the server
   *  is recovered here, claimed again, and crashes it again, so this path is
   *  exactly the loop `MAX_WAKEUP_ATTEMPTS` bounds. Retiring the exhausted ones
   *  happens in `abandonExhaustedHeartbeats`, which the runtime calls next. */
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
