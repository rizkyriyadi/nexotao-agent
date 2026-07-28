/* Aggregates for the work surface: cycle progress, burn-down, throughput and the
   distributions the analytics page charts.

   Two different sources, for a reason. Throughput and cycle time are derived from
   `activity_log`, which already records every `issue.transitioned` with `{from,
   to}` — an event stream answers "how many finished last week" exactly, and needs
   no table of its own. Burn-down cannot come from events: it asks how much work
   *remained* on a given day, and an issue added to a cycle mid-sprint changes the
   answer for days that already passed. That needs a daily total, which is what
   `cycle_snapshots` stores. */

import { and, eq, gte, inArray } from "drizzle-orm";
import { getDatabase } from "./db/database";
import { activityLog, agents, cycleSnapshots, cycles, issues } from "./db/schema";
import type { Issue } from "./issues";

export const DAY_MS = 86_400_000;
/** Epoch day. Snapshots are keyed by it so a second write on the same day
 *  replaces the first rather than adding a second point to the curve. */
export const dayOf = (timestamp: number) => Math.floor(timestamp / DAY_MS);

const DONE = new Set(["done", "cancelled"]);

export type CycleProgress = { total: number; completed: number; pending: number; points: number; completedPoints: number };
export type BurnPoint = { day: number; total: number; completed: number; pending: number };

/** How much of a set of work is finished. `cancelled` counts as completed — it is
 *  off the board either way, and a burn-down that never falls for abandoned work
 *  reads as a stalled sprint that is actually done. */
export function progressOf(list: readonly Pick<Issue, "status" | "estimatePoint">[]): CycleProgress {
  const completed = list.filter((issue) => DONE.has(issue.status));
  const points = (subset: readonly Pick<Issue, "estimatePoint">[]) => subset.reduce((sum, issue) => sum + (issue.estimatePoint ?? 0), 0);
  return {
    total: list.length, completed: completed.length, pending: list.length - completed.length,
    points: points(list), completedPoints: points(completed),
  };
}

/** Write today's counts for every cycle in a project. Called from `tick`, so the
 *  curve fills in while the project is being worked rather than needing a cron. */
export async function recordCycleSnapshots(projectId: string, now = Date.now()): Promise<void> {
  const database = await getDatabase();
  const day = dayOf(now);
  const rows = database.read((db) => ({
    cycleIds: db.select({ id: cycles.id }).from(cycles).where(eq(cycles.projectId, projectId)).all().map((row) => row.id),
    issues: db.select({ cycleId: issues.cycleId, status: issues.status }).from(issues).where(eq(issues.projectId, projectId)).all(),
  }));
  if (!rows.cycleIds.length) return;
  await database.write((db) => {
    for (const cycleId of rows.cycleIds) {
      const members = rows.issues.filter((issue) => issue.cycleId === cycleId);
      const completed = members.filter((issue) => DONE.has(issue.status)).length;
      db.insert(cycleSnapshots)
        .values({ cycleId, day, total: members.length, completed, pending: members.length - completed })
        .onConflictDoUpdate({
          target: [cycleSnapshots.cycleId, cycleSnapshots.day],
          set: { total: members.length, completed, pending: members.length - completed },
        }).run();
    }
  });
}

export async function burndown(cycleId: string): Promise<BurnPoint[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(cycleSnapshots).where(eq(cycleSnapshots.cycleId, cycleId)).all())
    .sort((a, b) => a.day - b.day);
}

/* ---------- project-wide analytics ---------- */

/** A charted category. `key` identifies the bucket, `label` is what the chart
 *  prints — they differ wherever the bucket is an id: an assignee tallies by
 *  agent id, and a bar reading `f982aa88-64a2-…` tells nobody anything. */
export type Distribution = Array<{ key: string; label: string; count: number }>;
export type Analytics = {
  throughput: Array<{ week: number; completed: number }>;
  byStatus: Distribution; byPriority: Distribution; byAssignee: Distribution;
  open: number; completed: number; averageCycleTimeMs: number | null;
};

const tally = (values: string[], name: (key: string) => string = (key) => key): Distribution => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, label: name(key), count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
};

/** The Monday-anchored week a timestamp falls in, as an epoch ms. Epoch day 0 was
 *  a Thursday, so Mondays are the days where `day % 7 === 4`; subtracting that
 *  offset before flooring puts the boundary on Monday rather than Thursday.
 *  Anchored in UTC, like `dayOf`, so a chart does not shift under a timezone. */
export const weekOf = (timestamp: number) => (Math.floor((dayOf(timestamp) - 4) / 7) * 7 + 4) * DAY_MS;

export async function projectAnalytics(projectId: string, weeks = 12): Promise<Analytics> {
  const database = await getDatabase();
  const since = Date.now() - weeks * 7 * DAY_MS;
  const rows = database.read((db) => {
    const list = db.select({
      id: issues.id, status: issues.status, priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId, createdAt: issues.createdAt, completedAt: issues.completedAt,
    }).from(issues).where(eq(issues.projectId, projectId)).all();
    const ids = list.map((issue) => issue.id);
    // Scoped to this project's issues so a second project's throughput never
    // bleeds into this chart.
    const events = ids.length
      ? db.select({ entityId: activityLog.entityId, summary: activityLog.summary, createdAt: activityLog.createdAt })
          .from(activityLog)
          .where(and(eq(activityLog.action, "issue.transitioned"), gte(activityLog.createdAt, since), inArray(activityLog.entityId, ids)))
          .all()
      : [];
    const crew = db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.projectId, projectId)).all();
    return { list, events, crew };
  });
  const agentName = new Map(rows.crew.map((agent) => [agent.id, agent.name]));

  const finished = rows.events.filter((event) => (event.summary as { to?: string } | null)?.to === "done");
  const perWeek = new Map<number, number>();
  // Every week in the window appears, including the empty ones — a throughput
  // chart that silently skips a quiet week reads as continuous delivery.
  for (let week = weekOf(since); week <= weekOf(Date.now()); week += 7 * DAY_MS) perWeek.set(week, 0);
  for (const event of finished) perWeek.set(weekOf(event.createdAt), (perWeek.get(weekOf(event.createdAt)) ?? 0) + 1);

  const durations = rows.list.filter((issue) => issue.completedAt != null).map((issue) => issue.completedAt! - issue.createdAt);
  return {
    throughput: [...perWeek].map(([week, completed]) => ({ week, completed })).sort((a, b) => a.week - b.week),
    byStatus: tally(rows.list.map((issue) => issue.status)),
    byPriority: tally(rows.list.map((issue) => issue.priority)),
    // An agent deleted after its work was assigned leaves an id with no name;
    // "Unknown agent" is more use on a chart than the bare uuid.
    byAssignee: tally(
      rows.list.map((issue) => issue.assigneeAgentId ?? "unassigned"),
      (key) => (key === "unassigned" ? "Unassigned" : agentName.get(key) ?? "Unknown agent"),
    ),
    open: rows.list.filter((issue) => !DONE.has(issue.status)).length,
    completed: rows.list.filter((issue) => DONE.has(issue.status)).length,
    averageCycleTimeMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
  };
}
