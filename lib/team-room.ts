/**
 * Live Team Room aggregation.
 *
 * Turns the flat issue board + agent roster into a real-time picture of the
 * team working together: who is active right now, what each agent is holding,
 * the hand-offs between them, and where work is blocked. This is Graphify's
 * work graph made *live* — it reads the same board the executor mutates on
 * every run and derives the current state, so a client that polls it sees the
 * room change as agents pick up, hand off, and finish work.
 *
 * Everything here is a pure function of (issues, agents, now); the API route is
 * the only place that touches the store, which keeps this fully unit-testable.
 */

import type { Agent, Issue } from "./issues";

// A run is still "in flight" while any of these statuses appear beneath it.
const ACTIVE_STATUS = new Set(["in_progress", "todo", "blocked"]);
// Statuses that count as an agent actively holding work-in-progress.
const WORKING_STATUS = new Set(["in_progress"]);
// Statuses that mean a piece of work is finished and no longer occupies anyone.
const DONE_STATUS = new Set(["done", "cancelled"]);

export type AgentPresence = "working" | "blocked" | "queued" | "idle";

export type CurrentTask = {
  issueId: string;
  title: string;
  status: Issue["status"];
  priority: string;
  runId: string | null;
  rootId: string;
  rootTitle: string;
  updatedAt: number;
};

export type TeamRoomAgent = {
  id: string;
  name: string;
  role: Agent["role"];
  avatar: string | null;
  reportsTo: string | null;
  presence: AgentPresence;
  /** The in-progress issue this agent is holding right now, if any. */
  current: CurrentTask | null;
  /** Assigned issues that are waiting (todo/backlog) — the agent's queue depth. */
  queued: number;
  /** Assigned issues currently blocked. */
  blocked: number;
};

export type HandOff = {
  id: string;
  kind: "delegate" | "blocked-on";
  fromAgentId: string | null;
  toAgentId: string | null;
  issueId: string;
  title: string;
  /** For blocked-on: the issue we are waiting on. */
  onIssueId?: string;
  onTitle?: string;
  at: number;
};

export type Blocker = {
  issueId: string;
  title: string;
  status: Issue["status"];
  assigneeAgentId: string | null;
  /** Unresolved dependencies this issue is waiting on. */
  waitingOn: { issueId: string; title: string; status: Issue["status"]; assigneeAgentId: string | null }[];
  at: number;
};

export type ActiveRun = {
  rootId: string;
  title: string;
  status: Issue["status"];
  runningCount: number;
  taskCount: number;
  agentIds: string[];
  updatedAt: number;
};

export type TeamRoomSnapshot = {
  generatedAt: number;
  stats: {
    agents: number;
    working: number;
    blocked: number;
    activeRuns: number;
    handoffs: number;
    blockers: number;
  };
  agents: TeamRoomAgent[];
  handoffs: HandOff[];
  blockers: Blocker[];
  runs: ActiveRun[];
};

/** Bounded walk up the parent chain to the root issue (defends against cycles). */
function rootOf(issue: Issue, byId: Map<string, Issue>): Issue {
  let cur = issue;
  for (let depth = 0; depth < 32; depth++) {
    if (!cur.parentId) return cur;
    const parent = byId.get(cur.parentId);
    if (!parent) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * Derive the live team-room snapshot from the current board.
 *
 * `now` is injected so tests are deterministic and so recency ranking never
 * depends on wall-clock inside this pure layer.
 */
export function buildTeamRoom(issues: Issue[], agents: Agent[], now: number): TeamRoomSnapshot {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  // ── Per-agent live state ───────────────────────────────────────────────────
  const roomAgents: TeamRoomAgent[] = agents.map((agent) => {
    const mine = issues.filter((i) => i.assigneeAgentId === agent.id);
    const working = mine
      .filter((i) => WORKING_STATUS.has(i.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const queued = mine.filter((i) => i.status === "todo" || i.status === "backlog").length;
    const blocked = mine.filter((i) => i.status === "blocked").length;

    let current: CurrentTask | null = null;
    if (working[0]) {
      const root = rootOf(working[0], byId);
      current = {
        issueId: working[0].id,
        title: working[0].title,
        status: working[0].status,
        priority: working[0].priority,
        runId: working[0].runId,
        rootId: root.id,
        rootTitle: root.title,
        updatedAt: working[0].updatedAt,
      };
    }

    const presence: AgentPresence = current
      ? "working"
      : blocked > 0
        ? "blocked"
        : queued > 0
          ? "queued"
          : "idle";

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      avatar: agent.avatar,
      reportsTo: agent.reportsTo,
      presence,
      current,
      queued,
      blocked,
    };
  });

  // Working agents first, then blocked, queued, idle; stable by name within.
  const presenceRank: Record<AgentPresence, number> = { working: 0, blocked: 1, queued: 2, idle: 3 };
  roomAgents.sort((a, b) => {
    if (a.role !== b.role) return a.role === "lead" ? -1 : 1;
    if (presenceRank[a.presence] !== presenceRank[b.presence]) return presenceRank[a.presence] - presenceRank[b.presence];
    return a.name.localeCompare(b.name);
  });

  // ── Hand-offs: parent→child delegation + blocked-on dependencies ───────────
  const handoffs: HandOff[] = [];
  for (const issue of issues) {
    // Delegation: a child issue assigned to a different agent than its parent,
    // where the child is still live (someone is carrying the handed-off work).
    if (issue.parentId) {
      const parent = byId.get(issue.parentId);
      if (
        parent &&
        parent.assigneeAgentId &&
        issue.assigneeAgentId &&
        parent.assigneeAgentId !== issue.assigneeAgentId &&
        !DONE_STATUS.has(issue.status)
      ) {
        handoffs.push({
          id: `d:${issue.id}`,
          kind: "delegate",
          fromAgentId: parent.assigneeAgentId,
          toAgentId: issue.assigneeAgentId,
          issueId: issue.id,
          title: issue.title,
          at: issue.updatedAt,
        });
      }
    }
    // Blocked-on: this issue is waiting on another that isn't finished yet.
    for (const depId of issue.blockedBy ?? []) {
      const dep = byId.get(depId);
      if (dep && !DONE_STATUS.has(dep.status)) {
        handoffs.push({
          id: `b:${issue.id}:${depId}`,
          kind: "blocked-on",
          fromAgentId: dep.assigneeAgentId,
          toAgentId: issue.assigneeAgentId,
          issueId: issue.id,
          title: issue.title,
          onIssueId: dep.id,
          onTitle: dep.title,
          at: issue.updatedAt,
        });
      }
    }
  }
  handoffs.sort((a, b) => b.at - a.at);

  // ── Blockers: blocked issues or issues with unresolved dependencies ────────
  const blockers: Blocker[] = [];
  for (const issue of issues) {
    if (DONE_STATUS.has(issue.status)) continue;
    const waitingOn = (issue.blockedBy ?? [])
      .map((depId) => byId.get(depId))
      .filter((dep): dep is Issue => Boolean(dep) && !DONE_STATUS.has(dep!.status))
      .map((dep) => ({ issueId: dep.id, title: dep.title, status: dep.status, assigneeAgentId: dep.assigneeAgentId }));
    if (issue.status === "blocked" || waitingOn.length > 0) {
      blockers.push({
        issueId: issue.id,
        title: issue.title,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        waitingOn,
        at: issue.updatedAt,
      });
    }
  }
  blockers.sort((a, b) => b.at - a.at);

  // ── Active runs: root issues with live work beneath, and who's in them ─────
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const root = rootOf(issue, byId);
    const members = groups.get(root.id);
    if (members) members.push(issue);
    else groups.set(root.id, [issue]);
  }
  const runs: ActiveRun[] = [];
  for (const [rootId, members] of groups) {
    const root = byId.get(rootId);
    if (!root) continue;
    if (!members.some((m) => ACTIVE_STATUS.has(m.status))) continue;
    const agentIds = Array.from(
      new Set(
        members
          .filter((m) => m.assigneeAgentId && !DONE_STATUS.has(m.status))
          .map((m) => m.assigneeAgentId as string)
          .filter((id) => agentById.has(id)),
      ),
    );
    runs.push({
      rootId,
      title: root.title,
      status: root.status,
      runningCount: members.filter((m) => m.status === "in_progress").length,
      taskCount: members.length - 1,
      agentIds,
      updatedAt: members.reduce((max, m) => Math.max(max, m.updatedAt ?? 0), 0),
    });
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt);

  const working = roomAgents.filter((a) => a.presence === "working").length;
  const blockedAgents = roomAgents.filter((a) => a.presence === "blocked").length;

  return {
    generatedAt: now,
    stats: {
      agents: roomAgents.length,
      working,
      blocked: blockedAgents,
      activeRuns: runs.length,
      handoffs: handoffs.length,
      blockers: blockers.length,
    },
    agents: roomAgents,
    handoffs,
    blockers,
    runs,
  };
}
