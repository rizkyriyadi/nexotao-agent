/**
 * Run summaries derived from the raw issue board.
 *
 * A "run" is a root issue (no parent) together with every issue delegated
 * beneath it. This groups the flat issue list into runs and works out, for
 * each one, whether it is currently executing and which node holds the live
 * transcript to jump to. Shared by the orchestrator view and the always-visible
 * active-run indicator so both agree on what "running" means.
 */

export type RunIssue = {
  id: string;
  parentId: string | null;
  title: string;
  status: string;
  updatedAt: number;
  runId?: string | null;
  assigneeAgentId?: string | null;
};

export type RunSummary = {
  rootId: string;
  title: string;
  status: string; // status of the root issue
  updatedAt: number; // most recent activity anywhere in the run
  active: boolean; // something in the run is still executing or queued
  runningCount: number; // nodes currently in_progress
  taskCount: number; // delegated nodes below the root
  liveNodeId: string; // node whose transcript to open ("jump to live")
  liveRunId: string | null;
};

/** Statuses that mean a run still has work in flight. */
const ACTIVE_STATUS = new Set(["in_progress", "todo", "blocked"]);

function rootOf(issue: RunIssue, byId: Map<string, RunIssue>): RunIssue {
  let cur = issue;
  // bounded walk up the parent chain (defends against cycles / orphans)
  for (let depth = 0; depth < 16; depth++) {
    if (!cur.parentId) return cur;
    const parent = byId.get(cur.parentId);
    if (!parent) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * Collapse the issue board into per-run summaries, sorted with active runs
 * first and most-recently-active first within each group.
 */
export function summarizeRuns(issues: RunIssue[]): RunSummary[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const groups = new Map<string, RunIssue[]>();
  for (const issue of issues) {
    const root = rootOf(issue, byId);
    const members = groups.get(root.id);
    if (members) members.push(issue);
    else groups.set(root.id, [issue]);
  }

  const summaries: RunSummary[] = [];
  for (const [rootId, members] of groups) {
    const root = byId.get(rootId);
    if (!root) continue;
    const running = members.filter((m) => m.status === "in_progress");
    // Prefer a running delegate (that's the interesting live transcript),
    // then a running root, then the root itself when nothing is executing.
    const live = running.find((m) => m.id !== rootId) ?? running[0] ?? root;
    summaries.push({
      rootId,
      title: root.title,
      status: root.status,
      updatedAt: members.reduce((max, m) => Math.max(max, m.updatedAt ?? 0), 0),
      active: members.some((m) => ACTIVE_STATUS.has(m.status)),
      runningCount: running.length,
      taskCount: members.length - 1,
      liveNodeId: live.id,
      liveRunId: live.runId ?? null,
    });
  }

  return summaries.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** Just the runs that are currently executing or queued. */
export function activeRuns(issues: RunIssue[]): RunSummary[] {
  return summarizeRuns(issues).filter((r) => r.active);
}
