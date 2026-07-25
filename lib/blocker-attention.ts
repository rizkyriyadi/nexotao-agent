/**
 * Blocker attention — "is this blocked-ness healthy?"
 *
 * A board that renders every blocked task identically is unreadable: "waiting on
 * three tasks an agent is actively working through" and "waiting on a task that
 * was cancelled, nobody is coming" look the same, so the user learns to distrust
 * all of it. This module walks the blocker DAG and separates those two cases.
 *
 * The rule it encodes is the liveness contract: a task is alive only if some
 * concrete thing will move it — a live run, a queued wakeup, or a human owner.
 * Comments and summaries are evidence, never liveness. A blocked task inherits
 * liveness from its chain: it is `covered` only when the unresolved leaves it is
 * waiting on are themselves alive.
 *
 * Pure functions of (issues, agents, wakeups, now) so the whole model is unit
 * testable; callers supply the snapshot.
 */

export const BLOCKER_ATTENTION_STATES = ["none", "covered", "stalled", "needs_attention"] as const;
export type BlockerAttentionState = (typeof BLOCKER_ATTENTION_STATES)[number];

/** Why a task needs attention. Drives the copy the user actually reads. */
export type BlockerAttentionReason =
  | "blocked_by_cancelled"
  | "blocked_without_blockers"
  | "blocker_unassigned"
  | "blocker_uninvokable"
  | "blocker_parked"
  | "blocker_review_stalled"
  | "dependency_cycle";

/** Traversal bounds. A malformed graph must never hang a page render. */
export const MAX_BLOCKER_DEPTH = 8;
export const MAX_BLOCKER_NODES = 2000;

/** Agent statuses that can never pick work up again without human intervention. */
const UNINVOKABLE_AGENT_STATUS = new Set(["paused", "error", "terminated"]);

export type AttentionIssue = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  blockedBy: string[];
  updatedAt: number;
};

export type AttentionAgent = { id: string; name: string; status: string };

/** A queued (not yet finished) wakeup. Presence means someone will be woken. */
export type AttentionWakeup = { issueId: string | null; status: string };

export type BlockerStep = {
  issueId: string;
  identifier: string;
  title: string;
  status: string;
  /** Depth in the blocker chain from the task under inspection (1 = direct). */
  depth: number;
  /** True when this blocker itself has a concrete thing moving it forward. */
  live: boolean;
};

export type BlockerAttention = {
  state: BlockerAttentionState;
  reason: BlockerAttentionReason | null;
  /** Direct + transitive blockers, nearest first. Renders the progress steps. */
  steps: BlockerStep[];
  /** Unresolved blockers that nothing is moving — what the copy names. */
  deadLeaves: BlockerStep[];
  /** Progress across direct blockers, for the segmented bar. */
  resolvedCount: number;
  totalCount: number;
  /** Oldest `updatedAt` among unresolved blockers — how long this has sat. */
  stoppedSinceAt: number | null;
};

export type BlockerAttentionSnapshot = {
  issues: AttentionIssue[];
  agents?: AttentionAgent[];
  wakeups?: AttentionWakeup[];
};

/** A blocker no longer holds anyone up once it reaches a terminal state.
 *  `cancelled` counts as resolved — the dependent must be freed — but it is
 *  flagged, because a cancelled blocker means the plan changed and nobody
 *  decided what replaces it. Treating it as unmet is what deadlocks the board. */
export function isBlockerResolved(status: string) {
  return status === "done" || status === "cancelled";
}

/** The liveness contract, per task. `blocked` is deliberately excluded: a
 *  blocked task borrows liveness from its chain, it never supplies its own. */
function isIssueLive(
  issue: AttentionIssue,
  agentsById: Map<string, AttentionAgent>,
  wakingIssueIds: Set<string>,
) {
  if (issue.status === "in_progress") return true;
  if (wakingIssueIds.has(issue.id)) return true;
  if (issue.status === "todo" || issue.status === "in_review") {
    const agent = issue.assigneeAgentId ? agentsById.get(issue.assigneeAgentId) : null;
    // in_review with no assignee is a review nobody owns — a stall, not liveness.
    if (!agent) return false;
    return !UNINVOKABLE_AGENT_STATUS.has(agent.status);
  }
  return false;
}

/** Why this particular unresolved blocker is going nowhere. */
function classifyDeadBlocker(
  blocker: AttentionIssue,
  agentsById: Map<string, AttentionAgent>,
): BlockerAttentionReason {
  if (blocker.status === "cancelled") return "blocked_by_cancelled";
  if (blocker.status === "backlog") return "blocker_parked";
  if (blocker.status === "in_review") return "blocker_review_stalled";
  if (!blocker.assigneeAgentId) return "blocker_unassigned";
  const agent = agentsById.get(blocker.assigneeAgentId);
  if (!agent || UNINVOKABLE_AGENT_STATUS.has(agent.status)) return "blocker_uninvokable";
  return "blocker_unassigned";
}

/** Rank so the surfaced reason is the one the user can act on first. */
const REASON_PRIORITY: BlockerAttentionReason[] = [
  "dependency_cycle",
  "blocked_without_blockers",
  "blocked_by_cancelled",
  "blocker_uninvokable",
  "blocker_unassigned",
  "blocker_parked",
  "blocker_review_stalled",
];

export function computeBlockerAttention(
  issueId: string,
  snapshot: BlockerAttentionSnapshot,
): BlockerAttention {
  const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const agentsById = new Map((snapshot.agents ?? []).map((agent) => [agent.id, agent]));
  const wakingIssueIds = new Set(
    (snapshot.wakeups ?? [])
      .filter((wakeup) => wakeup.issueId && (wakeup.status === "queued" || wakeup.status === "claimed"))
      .map((wakeup) => wakeup.issueId as string),
  );

  const empty: BlockerAttention = {
    state: "none", reason: null, steps: [], deadLeaves: [],
    resolvedCount: 0, totalCount: 0, stoppedSinceAt: null,
  };

  const root = byId.get(issueId);
  if (!root) return empty;

  const directIds = root.blockedBy.filter((id) => byId.has(id));
  const directBlockers = directIds.map((id) => byId.get(id)!);
  const resolvedCount = directBlockers.filter((blocker) => isBlockerResolved(blocker.status)).length;

  // Status `blocked` with no blocker edges: a free-text "blocked by X" in a
  // comment has no owner and no wake path, so it can never be sufficient.
  if (!directBlockers.length) {
    if (root.status === "blocked") {
      return { ...empty, state: "needs_attention", reason: "blocked_without_blockers" };
    }
    return empty;
  }

  // Breadth-first over the blocker DAG, bounded on both depth and node count.
  const steps: BlockerStep[] = [];
  const seen = new Set<string>([root.id]);
  let truncated = false;
  let frontier = directIds.map((id) => ({ id, depth: 1 }));
  while (frontier.length) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const node of frontier) {
      if (seen.has(node.id)) continue;
      if (steps.length >= MAX_BLOCKER_NODES) { truncated = true; break; }
      seen.add(node.id);
      const blocker = byId.get(node.id);
      if (!blocker) continue;
      steps.push({
        issueId: blocker.id, identifier: blocker.identifier, title: blocker.title,
        status: blocker.status, depth: node.depth,
        live: isIssueLive(blocker, agentsById, wakingIssueIds),
      });
      // Only walk *through* a blocker that is still holding things up; a resolved
      // one contributes nothing further down the chain.
      if (isBlockerResolved(blocker.status)) continue;
      if (node.depth >= MAX_BLOCKER_DEPTH) { truncated = true; continue; }
      for (const childId of blocker.blockedBy) {
        if (!seen.has(childId) && byId.has(childId)) next.push({ id: childId, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }

  const unresolved = steps.filter((step) => !isBlockerResolved(step.status));
  // Every blocker is done or cancelled: nothing is holding this task any more.
  // A cancelled one still needs a decision, so it is flagged rather than cleared.
  if (!unresolved.length) {
    const cancelled = steps.filter((step) => step.status === "cancelled");
    if (cancelled.length) {
      return {
        state: "needs_attention", reason: "blocked_by_cancelled", steps,
        deadLeaves: cancelled, resolvedCount, totalCount: directBlockers.length,
        stoppedSinceAt: Math.min(...cancelled.map((step) => byId.get(step.issueId)!.updatedAt)),
      };
    }
    return { ...empty, steps, resolvedCount, totalCount: directBlockers.length };
  }

  const deadLeaves = unresolved.filter((step) => !step.live);
  const stoppedSinceAt = Math.min(...unresolved.map((step) => byId.get(step.issueId)!.updatedAt));

  // Something concrete is moving every unresolved blocker: this task resumes on
  // its own. Calm, not an alert — the single most important distinction here.
  if (!deadLeaves.length) {
    return {
      state: "covered", reason: null, steps, deadLeaves: [],
      resolvedCount, totalCount: directBlockers.length, stoppedSinceAt,
    };
  }

  const reasons = deadLeaves.map((step) => classifyDeadBlocker(byId.get(step.issueId)!, agentsById));
  const reason = REASON_PRIORITY.find((candidate) => reasons.includes(candidate)) ?? "blocker_unassigned";
  // A review with no waiting path is stalled, not neglected — it has an owner,
  // it just has no next step. Anything else means nobody is on it at all.
  const state: BlockerAttentionState =
    reason === "blocker_review_stalled" ? "stalled" : "needs_attention";

  return {
    state, reason: truncated && !deadLeaves.length ? "dependency_cycle" : reason,
    steps, deadLeaves, resolvedCount, totalCount: directBlockers.length, stoppedSinceAt,
  };
}

export type BlockerAttentionOwnerKind = "agent" | "user" | "board" | "external";

export type BlockedAttention = BlockerAttention & {
  owner: { kind: BlockerAttentionOwnerKind; id: string | null; label: string };
  action: { label: string; detail: string };
  severity: "none" | "info" | "warning";
};

/** Layer 2 — "who unblocks it, and what do they do?" This is what the attention
 *  queue renders, and what the two banners in the task view read from. */
export function describeBlockedAttention(
  attention: BlockerAttention,
  snapshot: BlockerAttentionSnapshot,
): BlockedAttention {
  const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const agentsById = new Map((snapshot.agents ?? []).map((agent) => [agent.id, agent]));
  const leaf = attention.deadLeaves[0] ?? null;
  const leafIssue = leaf ? byId.get(leaf.issueId) ?? null : null;
  const leafAgent = leafIssue?.assigneeAgentId ? agentsById.get(leafIssue.assigneeAgentId) ?? null : null;

  if (attention.state === "none") {
    return {
      ...attention, severity: "none",
      owner: { kind: "board", id: null, label: "No blockers" },
      action: { label: "None", detail: "This task is not waiting on anything." },
    };
  }

  if (attention.state === "covered") {
    const running = attention.steps.find((step) => step.status === "in_progress");
    return {
      ...attention, severity: "info",
      owner: running
        ? { kind: "agent", id: byId.get(running.issueId)?.assigneeAgentId ?? null, label: "In progress" }
        : { kind: "agent", id: null, label: "Queued behind live work" },
      action: {
        label: "Wait",
        detail: `Queued behind ${attention.totalCount - attention.resolvedCount} of ${attention.totalCount} task(s) still being worked. Resumes automatically when the chain is done.`,
      },
    };
  }

  const name = leaf ? `${leaf.identifier}` : "an unknown task";
  switch (attention.reason) {
    case "blocked_without_blockers":
      return {
        ...attention, severity: "warning",
        owner: { kind: "board", id: null, label: "Board" },
        action: {
          label: "Add a blocker or unblock",
          detail: "This task is marked blocked but has no blocker link, so nothing can ever resolve it. Link the task it is waiting on, or move it back to todo.",
        },
      };
    case "blocked_by_cancelled":
      return {
        ...attention, severity: "warning",
        owner: { kind: "user", id: null, label: "You" },
        action: {
          label: "Clear the blocker",
          detail: `Blocked by ${name}, which was cancelled. Nothing will resume this. Clear the blocker or reassign the work.`,
        },
      };
    case "blocker_parked":
      return {
        ...attention, severity: "warning",
        owner: { kind: "board", id: null, label: "Board" },
        action: {
          label: `Start ${name}`,
          detail: `Waiting on ${name}, which is still in the backlog and is not scheduled to run. Move it to todo to start the chain.`,
        },
      };
    case "blocker_unassigned":
      return {
        ...attention, severity: "warning",
        owner: { kind: "board", id: null, label: "Board" },
        action: {
          label: `Assign ${name}`,
          detail: `Waiting on ${name}, which has no assignee. Nobody will pick it up until it is assigned.`,
        },
      };
    case "blocker_uninvokable":
      return {
        ...attention, severity: "warning",
        owner: { kind: "user", id: null, label: "You" },
        action: {
          label: "Resume or reassign the agent",
          detail: `Waiting on ${name}, assigned to ${leafAgent?.name ?? "an agent"} which is ${leafAgent?.status ?? "unavailable"}. Resume that agent or reassign the task.`,
        },
      };
    case "blocker_review_stalled":
      return {
        ...attention, severity: "warning",
        owner: { kind: "user", id: null, label: "You" },
        action: {
          label: `Review ${name}`,
          detail: `Waiting on ${name}, which is in review with no next step. Approve it or send it back.`,
        },
      };
    default:
      return {
        ...attention, severity: "warning",
        owner: { kind: "board", id: null, label: "Board" },
        action: {
          label: "Inspect the blocker chain",
          detail: `Waiting on ${name}. The blocker chain has no live work in it, so nothing will resume this on its own.`,
        },
      };
  }
}
