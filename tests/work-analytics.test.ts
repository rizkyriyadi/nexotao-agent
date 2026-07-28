import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Same harness as tests/work-model.test.ts: point the store at a throwaway dir
// before importing any lib module, and give each test its own projectId.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-work-analytics-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase } = await import("../lib/db/database");
const schema = await import("../lib/db/schema");
const { IssueLifecycleService } = await import("../lib/issue-lifecycle");
const { createIssue, updateIssue } = await import("../lib/issues");
const work = await import("../lib/work-model");
const analytics = await import("../lib/work-analytics");

const agentOf = (projectId: string) => `${projectId}-agent`;

async function makeProject(id: string) {
  const db = await getDatabase();
  await db.write((d) => {
    d.insert(schema.projects).values({ id, name: "Nexotao", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run();
    d.insert(schema.agents).values({ id: agentOf(id), projectId: id, name: "Hutao", role: "lead", scope: "", status: "idle", createdAt: 1, updatedAt: 1 }).run();
  });
  await work.ensureWorkflowStates(id);
}

/** Finish a work item the way the engine does. `todo → done` is not a legal
 *  transition: work reaches `in_progress` only through `checkout`, so a test that
 *  wrote `done` directly would be measuring a path production never takes. */
let runCounter = 0;
async function complete(issueId: string, projectId: string) {
  const lifecycle = new IssueLifecycleService(await getDatabase());
  // Only the assigned agent may check work out, so assignment is part of
  // finishing it — the same order production follows.
  await updateIssue(issueId, { assigneeAgentId: agentOf(projectId) }, { type: "user" });
  await lifecycle.checkout(issueId, agentOf(projectId), `run-${++runCounter}`);
  return updateIssue(issueId, { status: "done" }, { type: "user" });
}

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

/* ---------- progressOf ---------- */

test("progress counts cancelled work as finished, not as forever pending", () => {
  // A burn-down that never falls for abandoned work reads as a stalled sprint.
  const list = [
    { status: "done", estimatePoint: 3 }, { status: "cancelled", estimatePoint: 2 },
    { status: "todo", estimatePoint: 5 }, { status: "in_progress", estimatePoint: null },
  ] as const;
  const progress = analytics.progressOf(list);
  assert.deepEqual(progress, { total: 4, completed: 2, pending: 2, points: 10, completedPoints: 5 });
});

test("progress on nothing is zero rather than a division by zero", () => {
  assert.deepEqual(analytics.progressOf([]), { total: 0, completed: 0, pending: 0, points: 0, completedPoints: 0 });
});

/* ---------- weekOf / dayOf ---------- */

test("weeks are anchored to Monday, so a Sunday belongs to the week that just ended", () => {
  const monday = Date.UTC(2026, 6, 27); // 2026-07-27 is a Monday.
  const sunday = Date.UTC(2026, 7, 2, 23, 59);
  assert.equal(analytics.weekOf(monday), monday);
  assert.equal(analytics.weekOf(monday + 3 * analytics.DAY_MS), monday, "midweek maps back to the Monday");
  assert.equal(analytics.weekOf(sunday), monday, "Sunday closes the week, it does not open the next one");
  assert.equal(analytics.weekOf(monday + 7 * analytics.DAY_MS), monday + 7 * analytics.DAY_MS);
});

/* ---------- snapshots and burn-down ---------- */

test("a snapshot records the day's totals, and a second one that day replaces it", async () => {
  await makeProject("an1");
  const cycle = await work.createCycle({ projectId: "an1", name: "Sprint 1" });
  const first = await createIssue({ projectId: "an1", title: "One", status: "todo", cycleId: cycle.id });
  await createIssue({ projectId: "an1", title: "Two", status: "todo", cycleId: cycle.id });

  await analytics.recordCycleSnapshots("an1");
  assert.deepEqual(await analytics.burndown(cycle.id), [
    { cycleId: cycle.id, day: analytics.dayOf(Date.now()), total: 2, completed: 0, pending: 2 },
  ]);

  await complete(first.id, "an1");
  await analytics.recordCycleSnapshots("an1");
  const curve = await analytics.burndown(cycle.id);
  assert.equal(curve.length, 1, "the same day is one point on the curve, not two");
  assert.deepEqual([curve[0].total, curve[0].completed, curve[0].pending], [2, 1, 1]);
});

test("the curve keeps one point per day, in order", async () => {
  await makeProject("an2");
  const cycle = await work.createCycle({ projectId: "an2", name: "Sprint 2" });
  await createIssue({ projectId: "an2", title: "One", status: "todo", cycleId: cycle.id });
  // Two days recorded out of order; the curve must still read left to right.
  const today = Date.now();
  await analytics.recordCycleSnapshots("an2", today);
  await analytics.recordCycleSnapshots("an2", today - analytics.DAY_MS);
  const curve = await analytics.burndown(cycle.id);
  assert.equal(curve.length, 2);
  assert.ok(curve[0].day < curve[1].day, "ascending by day");
});

test("a project with no cycles records nothing rather than failing", async () => {
  await makeProject("an3");
  await analytics.recordCycleSnapshots("an3");
  assert.deepEqual(await analytics.burndown("no-such-cycle"), []);
});

/* ---------- project analytics ---------- */

test("throughput counts transitions into done and leaves quiet weeks visible", async () => {
  await makeProject("an4");
  const shipped = await createIssue({ projectId: "an4", title: "Shipped", status: "todo" });
  await createIssue({ projectId: "an4", title: "Still open", status: "todo" });
  await complete(shipped.id, "an4");

  const report = await analytics.projectAnalytics("an4", 4);
  assert.equal(report.throughput.length, 5, "four weeks back plus the current one, empties included");
  assert.equal(report.throughput.at(-1)!.completed, 1, "the completion lands in the current week");
  assert.equal(report.throughput.reduce((sum, week) => sum + week.completed, 0), 1);
  assert.deepEqual(report.throughput.map((week) => week.week), [...report.throughput].sort((a, b) => a.week - b.week).map((week) => week.week));
});

test("distributions and counts describe the project's own work only", async () => {
  await makeProject("an5");
  await createIssue({ projectId: "an5", title: "Urgent", status: "todo", priority: "urgent" });
  await createIssue({ projectId: "an5", title: "Also urgent", status: "backlog", priority: "urgent" });
  const done = await createIssue({ projectId: "an5", title: "Done", status: "todo", priority: "low" });
  await complete(done.id, "an5");

  const report = await analytics.projectAnalytics("an5");
  assert.deepEqual(report.byPriority, [{ key: "urgent", label: "urgent", count: 2 }, { key: "low", label: "low", count: 1 }]);
  assert.equal(report.open, 2);
  assert.equal(report.completed, 1);
  // Finishing work assigns it, so only the two open items are still unowned. The
  // assignee bucket keys by agent id but labels by name — a chart printing a uuid
  // names nobody.
  assert.deepEqual(report.byAssignee, [
    { key: "unassigned", label: "Unassigned", count: 2 },
    { key: "an5-agent", label: "Hutao", count: 1 },
  ], "unassigned work is a bucket, not a gap");
  assert.ok(report.averageCycleTimeMs !== null && report.averageCycleTimeMs >= 0);
});

test("an empty project reports zeroes rather than nulls the charts cannot draw", async () => {
  await makeProject("an6");
  const report = await analytics.projectAnalytics("an6", 2);
  assert.deepEqual(report.byStatus, []);
  assert.equal(report.open, 0);
  assert.equal(report.averageCycleTimeMs, null, "no completed work means no average to report");
  assert.ok(report.throughput.every((week) => week.completed === 0));
});
