import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* Drives the /api/work route handlers directly — no server, no browser. The
   guards these routes exist to preserve (a card cannot be dragged into In
   Progress; a column with cards cannot be deleted) live in the model, so what is
   worth testing here is that the HTTP layer still routes through it rather than
   writing the columns itself. */

const dir = await mkdtemp(path.join(tmpdir(), "nexotao-work-api-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase, defaultStateId } = await import("../lib/db/database");
const { saveConfig } = await import("../lib/config");
const { addProject } = await import("../lib/store");
const { createIssue, listIssues } = await import("../lib/issues");

const issuesRoute = await import("../app/api/work/issues/route");
const statesRoute = await import("../app/api/work/states/route");
const labelsRoute = await import("../app/api/work/labels/route");
const cyclesRoute = await import("../app/api/work/cycles/route");
const intakeRoute = await import("../app/api/work/intake/route");
const analyticsRoute = await import("../app/api/work/analytics/route");

const project = await addProject({ name: "Nexotao", path: dir });
await saveConfig({ activeProjectId: project.id });
const column = (key: string) => defaultStateId(project.id, key);

const get = (url = "http://localhost/api/work/issues") => new Request(url);
const send = (method: string, body: unknown, url = "http://localhost/api/work/issues") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (response: Response) => ({ status: response.status, body: await response.json() });

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

/* ---------- the board payload ---------- */

test("one GET returns the board and every vocabulary its pickers need", async () => {
  await createIssue({ projectId: project.id, title: "Seeded", status: "backlog" });
  const { status, body } = await json(await issuesRoute.GET(get()));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["agents", "cycles", "issues", "labels", "modules", "projectId", "states", "view"]);
  assert.equal(body.view.groups.length, 5, "all five columns, so the board can be dropped onto");
  assert.equal(body.view.config.layout, "board", "the default when the query names none");
});

test("query params drive the view rather than being ignored", async () => {
  const url = "http://localhost/api/work/issues?layout=list&groupBy=priority&orderBy=created&status=backlog";
  const { body } = await json(await issuesRoute.GET(get(url)));
  assert.deepEqual([body.view.config.layout, body.view.config.groupBy, body.view.config.orderBy], ["list", "priority", "created"]);
  assert.deepEqual(body.view.config.filters.statuses, ["backlog"]);
});

test("an unknown layout falls back instead of failing the whole board", async () => {
  const { status, body } = await json(await issuesRoute.GET(get("http://localhost/api/work/issues?layout=hologram")));
  assert.equal(status, 200);
  assert.equal(body.view.config.layout, "board");
});

/* ---------- creating ---------- */

test("a hand-typed card lands in Backlog, not in the agent's queue", async () => {
  const { status, body } = await json(await issuesRoute.POST(send("POST", { title: "Typed by hand", priority: "high" })));
  assert.equal(status, 201);
  assert.equal(body.issue.status, "backlog", "typing a card is not asking an agent to start");
  assert.equal(body.issue.stateId, column("backlog"));
  assert.equal(body.issue.priority, "high");
});

test("a create without a title is rejected before it reaches the model", async () => {
  const { status, body } = await json(await issuesRoute.POST(send("POST", { detail: "no title" })));
  assert.equal(status, 400);
  assert.match(body.error, /title/);
});

test("labels and modules given at create time are attached", async () => {
  const label = (await (await labelsRoute.POST(send("POST", { name: "ui" }, "http://localhost/api/work/labels"))).json()).label;
  const { body } = await json(await issuesRoute.POST(send("POST", { title: "Labelled", labelIds: [label.id] })));
  const stored = (await listIssues(project.id)).find((issue) => issue.id === body.issue.id)!;
  assert.deepEqual(stored.labelIds, [label.id]);
});

/* ---------- moving a card ---------- */

test("dragging a card into In Progress is refused with a 409, not silently applied", async () => {
  // The engine puts work there through checkout only; the board must not be a
  // second way in.
  const created = await createIssue({ projectId: project.id, title: "Drag me", status: "backlog" });
  const { status, body } = await json(await issuesRoute.PATCH(send("PATCH", { id: created.id, stateId: column("in_progress") })));
  assert.equal(status, 409);
  assert.match(body.error, /agent picks it up/);
  const after = (await listIssues(project.id)).find((issue) => issue.id === created.id)!;
  assert.equal(after.status, "backlog", "the refused move left nothing behind");
  assert.equal(after.stateId, column("backlog"), "and the card is back in its column");
});

test("dragging Backlog to Todo moves the card and the status together", async () => {
  const created = await createIssue({ projectId: project.id, title: "Ready", status: "backlog" });
  const { status, body } = await json(await issuesRoute.PATCH(send("PATCH", { id: created.id, stateId: column("todo"), sequence: 1.5 })));
  assert.equal(status, 200);
  assert.equal(body.issue.status, "todo", "the engine agreed to the transition");
  assert.equal(body.issue.stateId, column("todo"));
  assert.equal(body.issue.sequence, 1.5, "the drop position was recorded");
});

test("reordering inside a column writes the sequence without touching the status", async () => {
  const created = await createIssue({ projectId: project.id, title: "Reorder", status: "backlog" });
  const { body } = await json(await issuesRoute.PATCH(send("PATCH", { id: created.id, sequence: 4.25 })));
  assert.equal(body.issue.sequence, 4.25);
  assert.equal(body.issue.status, "backlog", "a reorder is not a transition");
});

test("patching an issue that does not exist is a 404", async () => {
  const { status } = await json(await issuesRoute.PATCH(send("PATCH", { id: "nope", title: "Ghost" })));
  assert.equal(status, 404);
});

/* ---------- columns ---------- */

test("a column may be added for a status that already has one", async () => {
  // "Code Review" and "QA" can both be in_review — that is the whole point of
  // separating the column from the status.
  const { status, body } = await json(await statesRoute.POST(send("POST", { name: "QA", statusGroup: "in_review" }, "http://localhost/api/work/states")));
  assert.equal(status, 201);
  assert.equal(body.state.statusGroup, "in_review");
  assert.equal(body.state.isDefault, false);
});

test("a column outside the canonical statuses is refused", async () => {
  const { status, body } = await json(await statesRoute.POST(send("POST", { name: "Limbo", statusGroup: "limbo" }, "http://localhost/api/work/states")));
  assert.equal(status, 400);
  assert.match(body.error, /status group/i);
});

test("deleting an occupied column is refused rather than stranding its cards", async () => {
  const created = (await (await statesRoute.POST(send("POST", { name: "Staging", statusGroup: "in_review" }, "http://localhost/api/work/states"))).json()).state;
  await createIssue({ projectId: project.id, title: "Parked", status: "backlog", stateId: created.id });
  const { status, body } = await json(await statesRoute.DELETE(get(`http://localhost/api/work/states?id=${created.id}`)));
  assert.equal(status, 409);
  assert.match(body.error, /still use this state/);
});

/* ---------- intake ---------- */

test("intake shows only what is waiting, and accepting clears it from the queue", async () => {
  const waiting = await createIssue({ projectId: project.id, title: "From outside", status: "backlog", intakeStatus: "pending", intakeSource: "external" });
  const before = await json(await intakeRoute.GET());
  assert.ok(before.body.pending.some((issue: { id: string }) => issue.id === waiting.id));

  const { status, body } = await json(await intakeRoute.POST(send("POST", { issueId: waiting.id, decision: "accept" }, "http://localhost/api/work/intake")));
  assert.equal(status, 200);
  assert.equal(body.issue.intakeStatus, "accepted");
  assert.equal(body.issue.status, "backlog");

  const after = await json(await intakeRoute.GET());
  assert.ok(!after.body.pending.some((issue: { id: string }) => issue.id === waiting.id), "a decided item leaves the queue");
  assert.ok(after.body.recent.some((issue: { id: string }) => issue.id === waiting.id), "but stays visible, so a mis-click is recoverable");
});

/* Accepting used to force the item to `backlog`, which the lifecycle refuses for
   anything past `todo` — so an item flagged pending while already in review
   returned 409 and stayed in the queue forever, with no way to clear it. */
test("accepting work that is already underway does not demote it", async () => {
  const underway = await createIssue({ projectId: project.id, title: "Already in review", status: "in_review", intakeStatus: "pending" });
  const { status, body } = await json(await intakeRoute.POST(send("POST", { issueId: underway.id, decision: "accept" }, "http://localhost/api/work/intake")));
  assert.equal(status, 200);
  assert.equal(body.issue.status, "in_review", "accepting is a triage decision, not a status change");
  assert.equal(body.issue.intakeStatus, "accepted");
});

test("declining cancels the work rather than only flagging it", async () => {
  const waiting = await createIssue({ projectId: project.id, title: "Not for us", status: "backlog", intakeStatus: "pending" });
  const { body } = await json(await intakeRoute.POST(send("POST", { issueId: waiting.id, decision: "decline" }, "http://localhost/api/work/intake")));
  assert.equal(body.issue.status, "cancelled", "the scheduler can see the decision, not just the UI");
  assert.equal(body.issue.intakeStatus, "declined");
});

test("snoozing clears the queue without changing what the engine sees", async () => {
  const waiting = await createIssue({ projectId: project.id, title: "Later", status: "todo", intakeStatus: "pending" });
  const { body } = await json(await intakeRoute.POST(send("POST", { issueId: waiting.id, decision: "snooze" }, "http://localhost/api/work/intake")));
  assert.equal(body.issue.status, "todo");
  assert.equal(body.issue.intakeStatus, "snoozed");
});

test("an unknown decision is refused", async () => {
  const waiting = await createIssue({ projectId: project.id, title: "Odd", status: "backlog", intakeStatus: "pending" });
  const { status } = await json(await intakeRoute.POST(send("POST", { issueId: waiting.id, decision: "ignore" }, "http://localhost/api/work/intake")));
  assert.equal(status, 400);
});

/* ---------- cycles and analytics ---------- */

test("a cycle reports progress without a request per row", async () => {
  const cycle = (await (await cyclesRoute.POST(send("POST", { name: "Sprint 1" }, "http://localhost/api/work/cycles"))).json()).cycle;
  await createIssue({ projectId: project.id, title: "In the sprint", status: "backlog", cycleId: cycle.id });
  const { body } = await json(await cyclesRoute.GET());
  const listed = body.cycles.find((row: { id: string }) => row.id === cycle.id);
  assert.deepEqual([listed.progress.total, listed.progress.completed], [1, 0]);
});

test("a cycle cannot end before it starts", async () => {
  const { status } = await json(await cyclesRoute.POST(send("POST", { name: "Backwards", startDate: 2_000, endDate: 1_000 }, "http://localhost/api/work/cycles")));
  assert.equal(status, 400);
});

test("analytics answers with charts that can be drawn on an untouched project", async () => {
  const { status, body } = await json(await analyticsRoute.GET(get("http://localhost/api/work/analytics?weeks=4")));
  assert.equal(status, 200);
  assert.equal(body.analytics.throughput.length, 5, "four weeks back plus the current one");
  assert.ok(Array.isArray(body.analytics.byStatus));
  assert.ok(Array.isArray(body.cycles), "one burn-down curve per cycle");
});
