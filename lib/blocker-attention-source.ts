/**
 * Adapts stored rows into the shape `blocker-attention` reasons over.
 *
 * The attention model itself is deliberately free of drizzle and of the store's
 * types so it stays trivially testable; this is the one place that knows how a
 * board snapshot maps onto it. Route handlers should call these rather than
 * assembling the snapshot themselves, so every surface classifies blocked work
 * identically.
 */

import { inArray } from "drizzle-orm";
import type { AppDatabase } from "./db/database";
import { wakeupRequests } from "./db/schema";
import type { Agent, Issue } from "./issues";
import {
  computeBlockerAttention, describeBlockedAttention,
  type AttentionWakeup, type BlockedAttention, type BlockerAttentionSnapshot,
} from "./blocker-attention";

/** Wakeups that have not finished — the durable "someone will be woken" signal. */
export function readPendingWakeups(database: AppDatabase, issueIds: string[]): AttentionWakeup[] {
  if (!issueIds.length) return [];
  return database.read((db) =>
    db.select({ issueId: wakeupRequests.issueId, status: wakeupRequests.status })
      .from(wakeupRequests)
      .where(inArray(wakeupRequests.issueId, issueIds))
      .all(),
  );
}

export function buildAttentionSnapshot(
  issues: Issue[],
  agents: Agent[],
  wakeups: AttentionWakeup[] = [],
): BlockerAttentionSnapshot {
  return {
    issues: issues.map((issue) => ({
      id: issue.id, identifier: issue.ref, title: issue.title, status: issue.status,
      assigneeAgentId: issue.assigneeAgentId, blockedBy: issue.blockedBy, updatedAt: issue.updatedAt,
    })),
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
    wakeups,
  };
}

/** One call for a route: classify a task and describe who unblocks it. */
export function resolveBlockedAttention(
  issueId: string,
  issues: Issue[],
  agents: Agent[],
  wakeups: AttentionWakeup[] = [],
): BlockedAttention {
  const snapshot = buildAttentionSnapshot(issues, agents, wakeups);
  return describeBlockedAttention(computeBlockerAttention(issueId, snapshot), snapshot);
}

/** Board-wide pass for the attention queue: every task that needs a human,
 *  worst first. Covered work is deliberately excluded — it is healthy. */
export function attentionQueue(
  issues: Issue[],
  agents: Agent[],
  wakeups: AttentionWakeup[] = [],
) {
  const snapshot = buildAttentionSnapshot(issues, agents, wakeups);
  return issues
    .filter((issue) => issue.status !== "done" && issue.status !== "cancelled")
    .map((issue) => ({
      issue,
      attention: describeBlockedAttention(computeBlockerAttention(issue.id, snapshot), snapshot),
    }))
    .filter((entry) => entry.attention.state === "needs_attention" || entry.attention.state === "stalled")
    .sort((a, b) =>
      // Needs-attention outranks stalled; within a state, longest-stopped first.
      (a.attention.state === b.attention.state ? 0 : a.attention.state === "needs_attention" ? -1 : 1)
      || (a.attention.stoppedSinceAt ?? Infinity) - (b.attention.stoppedSinceAt ?? Infinity),
    );
}
