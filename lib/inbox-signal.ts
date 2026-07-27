/* Pure logic for the Inbox attention signal: turns an /api/inbox snapshot into a
   stable set of item ids, an unread count, and a human summary for notifications.
   Kept framework-free so it is unit-testable and reusable from the nav badge hook. */

export type InboxItemKind = "approval" | "issue" | "run";

export type InboxSnapshot = {
  approvals?: Array<{ id: string }>;
  issues?: Array<{ id: string }>;
  runs?: Array<{ id: string }>;
};

const KINDS: InboxItemKind[] = ["approval", "issue", "run"];

const LABELS: Record<InboxItemKind, [string, string]> = {
  approval: ["approval", "approvals"],
  issue: ["task", "tasks"],
  run: ["run needs attention", "runs need attention"],
};

export type AttentionRun = {
  id: string; status: "failed" | "stale"; error: string | null;
  issueId: string | null; startedAt: number; href: string;
};

const STALE_AFTER_MS = 10 * 60_000;

/* Select the runs that need attention from the two tables that record a run.
   A durable run writes a `heartbeat_runs` row *and* a `run_records` row under
   the same id, so listing both surfaces one failure twice — as "failed" from
   the heartbeat and again as "stale" from the record, whose status stays
   `running` because the heartbeat is what gets finalized. The heartbeat is
   authoritative (it alone carries the error text), so records it already
   covers are dropped and only genuinely legacy rows survive. */
export function selectAttentionRuns(input: {
  now: number;
  heartbeats: Array<{ id: string; status: string; error: string | null; issueId: string | null; startedAt: number; updatedAt?: number | null }>;
  records: Array<{ id: string; status: string; createdAt: number; updatedAt: number }>;
}): AttentionRun[] {
  const stale = input.now - STALE_AFTER_MS;
  const covered = new Set(input.heartbeats.map((run) => run.id));
  return [
    ...input.heartbeats
      .filter((run) => run.status === "failed" || (run.updatedAt ?? run.startedAt) < stale)
      .map((run) => ({
        id: run.id, status: (run.status === "failed" ? "failed" : "stale") as AttentionRun["status"],
        error: run.error, issueId: run.issueId, startedAt: run.startedAt,
        href: run.issueId ? `/board/${run.issueId}` : "/board",
      })),
    ...input.records
      .filter((run) => !covered.has(run.id))
      .filter((run) => run.status === "error" || (run.status === "running" && run.updatedAt < stale))
      .map((run) => ({
        id: run.id, status: (run.status === "error" ? "failed" : "stale") as AttentionRun["status"],
        error: null, issueId: null, startedAt: run.createdAt, href: "/board",
      })),
  ];
}

/* Namespaced ids so the same underlying id in two sections can't collide. */
export function inboxItemIds(data: InboxSnapshot): string[] {
  return [
    ...(data.approvals ?? []).map((item) => `approval:${item.id}`),
    ...(data.issues ?? []).map((item) => `issue:${item.id}`),
    ...(data.runs ?? []).map((item) => `run:${item.id}`),
  ];
}

export function inboxCount(data: InboxSnapshot): number {
  return inboxItemIds(data).length;
}

/* Ids present now that the user has not acknowledged yet. */
export function unreadIds(ids: string[], seen: Iterable<string>): string[] {
  const seenSet = seen instanceof Set ? seen : new Set(seen);
  return ids.filter((id) => !seenSet.has(id));
}

/* Ids present now that were absent on the previous poll — the trigger for a toast. */
export function newlyArrived(current: string[], previous: string[]): string[] {
  const before = new Set(previous);
  return current.filter((id) => !before.has(id));
}

export function kindOf(id: string): InboxItemKind | null {
  const kind = id.split(":", 1)[0];
  return (KINDS as string[]).includes(kind) ? (kind as InboxItemKind) : null;
}

/* "2 approvals · 1 task" — a compact, pluralized summary of a set of item ids. */
export function describeInboxItems(ids: string[]): string {
  const counts: Record<InboxItemKind, number> = { approval: 0, issue: 0, run: 0 };
  for (const id of ids) {
    const kind = kindOf(id);
    if (kind) counts[kind] += 1;
  }
  const parts: string[] = [];
  for (const kind of KINDS) {
    const n = counts[kind];
    if (n > 0) parts.push(`${n} ${n === 1 ? LABELS[kind][0] : LABELS[kind][1]}`);
  }
  return parts.join(" · ");
}
