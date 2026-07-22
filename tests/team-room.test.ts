import test from "node:test";
import assert from "node:assert/strict";
import { buildTeamRoom } from "../lib/team-room";
import type { Agent, Issue } from "../lib/issues";

const NOW = 1_000_000;

function agent(id: string, name: string, role: "lead" | "worker", reportsTo: string | null = null): Agent {
  return { id, projectId: "p", name, role, scope: "", avatar: null, reportsTo, createdAt: 1 };
}

function issue(over: Partial<Issue> & Pick<Issue, "id">): Issue {
  return {
    projectId: "p", ref: over.id, title: over.id, detail: "", parentId: null,
    assigneeAgentId: null, createdByAgentId: null, status: "todo", stage: "execute",
    priority: "medium", runMode: "agent", blockedBy: [], runId: null, summary: "",
    createdAt: 1, updatedAt: 1, ...over,
  } as Issue;
}

test("empty board yields an empty, well-formed room", () => {
  const room = buildTeamRoom([], [], NOW);
  assert.equal(room.generatedAt, NOW);
  assert.deepEqual(room.agents, []);
  assert.deepEqual(room.handoffs, []);
  assert.deepEqual(room.blockers, []);
  assert.deepEqual(room.runs, []);
  assert.equal(room.stats.working, 0);
});

test("agent presence reflects current work, queue, and blocks", () => {
  const agents = [agent("lead", "Hutao", "lead"), agent("w1", "Furina", "worker", "lead"), agent("w2", "Aoteru", "worker", "lead")];
  const issues = [
    issue({ id: "root", title: "Ship feature", assigneeAgentId: "lead", status: "in_progress" }),
    issue({ id: "t1", title: "Build API", parentId: "root", assigneeAgentId: "w1", status: "in_progress", updatedAt: 5 }),
    issue({ id: "t2", title: "Queued work", parentId: "root", assigneeAgentId: "w2", status: "todo" }),
    issue({ id: "t3", title: "Blocked work", parentId: "root", assigneeAgentId: "w2", status: "blocked" }),
  ];
  const room = buildTeamRoom(issues, agents, NOW);

  const w1 = room.agents.find((a) => a.id === "w1")!;
  assert.equal(w1.presence, "working");
  assert.equal(w1.current?.title, "Build API");
  assert.equal(w1.current?.rootTitle, "Ship feature");
  assert.equal(w1.current?.rootId, "root");

  const w2 = room.agents.find((a) => a.id === "w2")!;
  // Owns a blocked issue and a queued one, none in progress → blocked takes precedence.
  assert.equal(w2.presence, "blocked");
  assert.equal(w2.blocked, 1);
  assert.equal(w2.queued, 1);

  assert.equal(room.stats.working, 2); // lead + w1
  assert.equal(room.stats.blocked, 1);
  // Lead sorts first (role), working agents ahead of blocked.
  assert.equal(room.agents[0].role, "lead");
});

test("delegation and blocked-on hand-offs are derived", () => {
  const agents = [agent("lead", "Hutao", "lead"), agent("w1", "Furina", "worker", "lead")];
  const issues = [
    issue({ id: "root", assigneeAgentId: "lead", status: "in_progress" }),
    issue({ id: "child", title: "Delegated", parentId: "root", assigneeAgentId: "w1", status: "in_progress", updatedAt: 9 }),
    issue({ id: "dep", title: "Dependency", assigneeAgentId: "lead", status: "in_progress" }),
    issue({ id: "waiter", title: "Waiting task", assigneeAgentId: "w1", status: "todo", blockedBy: ["dep"], updatedAt: 3 }),
  ];
  const room = buildTeamRoom(issues, agents, NOW);

  const delegate = room.handoffs.find((h) => h.kind === "delegate")!;
  assert.equal(delegate.fromAgentId, "lead");
  assert.equal(delegate.toAgentId, "w1");
  assert.equal(delegate.issueId, "child");

  const blockedOn = room.handoffs.find((h) => h.kind === "blocked-on")!;
  assert.equal(blockedOn.issueId, "waiter");
  assert.equal(blockedOn.onIssueId, "dep");
  assert.equal(blockedOn.fromAgentId, "lead"); // the blocker's owner

  // Newest-first ordering by updatedAt.
  assert.ok(room.handoffs[0].at >= room.handoffs[room.handoffs.length - 1].at);
});

test("blockers list unresolved dependencies and skip finished ones", () => {
  const agents = [agent("w1", "Furina", "worker")];
  const issues = [
    issue({ id: "doneDep", title: "Finished dep", status: "done" }),
    issue({ id: "openDep", title: "Open dep", assigneeAgentId: "w1", status: "in_progress" }),
    issue({ id: "waiter", title: "Waiter", assigneeAgentId: "w1", status: "todo", blockedBy: ["doneDep", "openDep"] }),
    issue({ id: "hardBlocked", title: "Hard blocked", assigneeAgentId: "w1", status: "blocked" }),
  ];
  const room = buildTeamRoom(issues, agents, NOW);

  const waiter = room.blockers.find((b) => b.issueId === "waiter")!;
  assert.equal(waiter.waitingOn.length, 1); // done dep excluded
  assert.equal(waiter.waitingOn[0].issueId, "openDep");

  // A `blocked` status issue counts even with no dependencies.
  assert.ok(room.blockers.some((b) => b.issueId === "hardBlocked"));
  assert.equal(room.stats.blockers, 2);
});

test("active runs group members and their agents, excluding done runs", () => {
  const agents = [agent("lead", "Hutao", "lead"), agent("w1", "Furina", "worker")];
  const issues = [
    issue({ id: "liveRoot", title: "Live run", assigneeAgentId: "lead", status: "in_progress", updatedAt: 10 }),
    issue({ id: "liveChild", parentId: "liveRoot", assigneeAgentId: "w1", status: "in_progress", updatedAt: 12 }),
    issue({ id: "doneRoot", title: "Done run", assigneeAgentId: "lead", status: "done" }),
    issue({ id: "doneChild", parentId: "doneRoot", assigneeAgentId: "w1", status: "done" }),
  ];
  const room = buildTeamRoom(issues, agents, NOW);

  assert.equal(room.runs.length, 1);
  const run = room.runs[0];
  assert.equal(run.rootId, "liveRoot");
  assert.equal(run.runningCount, 2);
  assert.equal(run.taskCount, 1);
  assert.deepEqual(new Set(run.agentIds), new Set(["lead", "w1"]));
});
