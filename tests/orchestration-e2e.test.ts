import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase, type AppDatabase } from "../lib/db/database";
import { agents, issueDependencies, issues, projects, wakeupRequests } from "../lib/db/schema";
import { IssueLifecycleService } from "../lib/issue-lifecycle";
import { buildTeamRoom } from "../lib/team-room";
import type { Agent, Issue } from "../lib/issues";

// End-to-end orchestration: a multi-agent dependency chain must hand off on its
// own. When an assigned issue with unmet blockers is created it parks in
// `blocked`; finishing a blocker must auto-release the next issue to `todo` and
// enqueue exactly one durable wakeup for its assignee — that enqueue is the
// orchestrator's hand-off. buildTeamRoom must then surface the live board so the
// team room / orchestrator views reflect who is working, queued, or blocked.
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-orch-e2e-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => {
    db.insert(projects).values({ id: "project", name: "Ship a SaaS", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run();
    db.insert(agents).values([
      { id: "pm", projectId: "project", name: "Priya", role: "worker", scope: "product", createdAt: 2, updatedAt: 2 },
      { id: "dev", projectId: "project", name: "Dev", role: "worker", scope: "engineering", createdAt: 3, updatedAt: 3 },
      { id: "qa", projectId: "project", name: "Quinn", role: "worker", scope: "quality", createdAt: 4, updatedAt: 4 },
    ]).run();
  });
  return { dir, database, lifecycle: new IssueLifecycleService(database) };
}

async function cleanup(dir: string, database: AppDatabase) {
  await database.close();
  await rm(dir, { recursive: true, force: true });
}

function loadAgents(database: AppDatabase): Agent[] {
  return database.read((db) => db.select().from(agents).where(eq(agents.projectId, "project")).all()).map((row) => ({
    id: row.id, projectId: row.projectId, name: row.name, role: row.role as "lead" | "worker",
    scope: row.scope ?? "", avatar: null, reportsTo: null, createdAt: row.createdAt,
  }));
}

function loadIssues(database: AppDatabase): Issue[] {
  const rows = database.read((db) => db.select().from(issues).where(eq(issues.projectId, "project")).all());
  const deps = database.read((db) => db.select().from(issueDependencies).all());
  return rows.map((row) => ({
    id: row.id, projectId: row.projectId, ref: row.identifier, title: row.title, detail: row.description,
    parentId: row.parentId, assigneeAgentId: row.assigneeAgentId, createdByAgentId: row.createdByAgentId,
    status: row.status as Issue["status"], stage: row.stage as Issue["stage"], priority: row.priority,
    runMode: (row.runMode as Issue["runMode"]) ?? "agent",
    blockedBy: deps.filter((d) => d.issueId === row.id).map((d) => d.blockerIssueId),
    runId: row.checkoutRunId, summary: row.summary, createdAt: row.createdAt, updatedAt: row.updatedAt,
  }));
}

function chainWakeups(database: AppDatabase, issueIds: string[]) {
  return database.read((db) => db.select().from(wakeupRequests).all()).filter((w) => w.issueId !== null && issueIds.includes(w.issueId));
}

test("a multi-agent dependency chain hands off on its own, end to end", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    // A three-stage chain across three agents: scope -> build -> QA.
    const scope = await lifecycle.create({ projectId: "project", title: "Scope MVP", assigneeAgentId: "pm", status: "todo", now: 10 });
    const build = await lifecycle.create({ projectId: "project", title: "Build API", assigneeAgentId: "dev", status: "todo", blockerIds: [scope.id], now: 11 });
    const qa = await lifecycle.create({ projectId: "project", title: "QA sign-off", assigneeAgentId: "qa", status: "todo", blockerIds: [build.id], now: 12 });
    const ids = [scope.id, build.id, qa.id];

    // Unmet blockers park the dependents in `blocked`; only the head is runnable.
    assert.equal(scope.status, "todo");
    assert.equal(build.status, "blocked");
    assert.equal(qa.status, "blocked");

    // Exactly one wakeup so far — the head issue's assignment. No premature
    // hand-off to the blocked downstream agents.
    let wakes = chainWakeups(database, ids);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].issueId, scope.id);
    assert.equal(wakes[0].reason, "assignment");

    // The board mid-flight: PM owns the runnable head, Dev and Quinn are blocked.
    let room = buildTeamRoom(loadIssues(database), loadAgents(database), 1_000_000);
    assert.equal(room.agents.find((a) => a.id === "dev")!.presence, "blocked");
    assert.equal(room.agents.find((a) => a.id === "qa")!.presence, "blocked");
    assert.ok(room.blockers.length >= 2, "team room surfaces the blocked downstream work");

    // HAND-OFF #1 — finish scope; Build must auto-release and enqueue Dev.
    await lifecycle.checkout(scope.id, "pm", "run-scope", 20);
    await lifecycle.transition(scope.id, "done", { type: "agent", id: "pm", runId: "run-scope" }, 21);

    let now = loadIssues(database);
    assert.equal(now.find((i) => i.id === build.id)!.status, "todo", "Build auto-released after its blocker completed");
    assert.equal(now.find((i) => i.id === qa.id)!.status, "blocked", "QA still blocked by Build");

    wakes = chainWakeups(database, ids);
    const buildWake = wakes.find((w) => w.issueId === build.id);
    assert.ok(buildWake, "a durable wakeup was enqueued for the newly-runnable Build issue");
    assert.equal(buildWake!.reason, "dependency", "the hand-off wakeup is attributed to the resolved dependency");

    // HAND-OFF #2 — finish build; QA must auto-release and enqueue Quinn.
    await lifecycle.checkout(build.id, "dev", "run-build", 30);
    await lifecycle.transition(build.id, "done", { type: "agent", id: "dev", runId: "run-build" }, 31);

    now = loadIssues(database);
    assert.equal(now.find((i) => i.id === qa.id)!.status, "todo", "QA auto-released after Build completed");

    wakes = chainWakeups(database, ids);
    const qaWake = wakes.find((w) => w.issueId === qa.id);
    assert.ok(qaWake, "a durable wakeup was enqueued for the newly-runnable QA issue");
    assert.equal(qaWake!.reason, "dependency");

    // Idempotency: each stage produced exactly one wakeup — no duplicate
    // hand-offs from re-evaluating the dependency graph.
    assert.equal(chainWakeups(database, ids).length, 3);

    // Final board reflects the completed hand-off chain.
    room = buildTeamRoom(loadIssues(database), loadAgents(database), 2_000_000);
    assert.equal(room.agents.find((a) => a.id === "qa")!.presence, "queued");
  } finally {
    await cleanup(dir, database);
  }
});

test("completing the head does not skip a still-blocked grandchild", async () => {
  const { dir, database, lifecycle } = await fixture();
  try {
    const a = await lifecycle.create({ projectId: "project", title: "A", assigneeAgentId: "pm", status: "todo", now: 10 });
    const b = await lifecycle.create({ projectId: "project", title: "B", assigneeAgentId: "dev", status: "todo", blockerIds: [a.id], now: 11 });
    const c = await lifecycle.create({ projectId: "project", title: "C", assigneeAgentId: "qa", status: "todo", blockerIds: [a.id, b.id], now: 12 });

    await lifecycle.checkout(a.id, "pm", "run-a", 20);
    await lifecycle.transition(a.id, "done", { type: "agent", id: "pm", runId: "run-a" }, 21);

    const now = loadIssues(database);
    // B releases (its only blocker A is done); C stays blocked (B not yet done).
    assert.equal(now.find((i) => i.id === b.id)!.status, "todo");
    assert.equal(now.find((i) => i.id === c.id)!.status, "blocked");
    assert.equal(chainWakeups(database, [c.id]).length, 0, "no premature wakeup for the grandchild");
  } finally {
    await cleanup(dir, database);
  }
});
