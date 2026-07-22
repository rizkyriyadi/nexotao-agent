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
