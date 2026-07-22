import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";

async function fixture() { return mkdtemp(path.join(tmpdir(), "nexotao-db-test-")); }

test("control-plane records survive a database restart", async () => {
  const dir = await fixture();
  const file = path.join(dir, "nexotao.sqlite");
  try {
    let database = await openDatabase(file, { migrateJson: false });
    await database.write((db) => db.insert(projects).values({ id: "project-1", name: "Example", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
    let repositories = new ControlPlaneRepositories(database);
    await repositories.agents.insert({ id: "agent-1", projectId: "project-1", name: "Lead", role: "lead", scope: "Lead", createdAt: 2, updatedAt: 2 });
    await repositories.issues.insert({ id: "issue-1", projectId: "project-1", identifier: "NX-1", title: "Persist", status: "todo", assigneeAgentId: "agent-1", createdAt: 3, updatedAt: 3 });
    const checkouts = await Promise.all([repositories.checkoutIssue("issue-1", "agent-1", "run-1"), repositories.checkoutIssue("issue-1", "agent-1", "run-2")]);
    assert.equal(checkouts.filter(Boolean).length, 1);
    await repositories.addComment({ issueId: "issue-1", authorType: "user", body: "keep me" });
    await repositories.putDocument({ issueId: "issue-1", key: "plan", body: "revision one", createdByType: "agent" });
    await repositories.putDocument({ issueId: "issue-1", key: "plan", body: "revision two", createdByType: "agent" });
    await repositories.createHeartbeat({ agentId: "agent-1", issueId: "issue-1", source: "assignment", status: "done", startedAt: 4, finishedAt: 5 });
    const firstWakeup = await repositories.enqueueWakeup({ agentId: "agent-1", issueId: "issue-1", reason: "assignment", idempotencyKey: "wake-1", status: "queued", availableAt: 6 });
    const sameWakeup = await repositories.enqueueWakeup({ agentId: "agent-1", issueId: "issue-1", reason: "duplicate", idempotencyKey: "wake-1", status: "queued", availableAt: 7 });
    assert.equal(sameWakeup.id, firstWakeup.id);
    await repositories.appendRunEvent({ runId: "run-1", seq: 1, type: "status", redactedPayload: { status: "done" }, createdAt: 8 });
    await repositories.createApproval({ type: "shell", issueId: "issue-1", runId: "run-1", payload: { command: "npm test" }, status: "approved" });
    await repositories.appendActivity({ actorType: "agent", actorId: "agent-1", action: "completed", entityType: "issue", entityId: "issue-1", summary: { status: "done" }, runId: "run-1" });
    await database.close();

    database = await openDatabase(file, { migrateJson: false });
    repositories = new ControlPlaneRepositories(database);
    assert.equal(repositories.agents.get("agent-1")?.name, "Lead");
    assert.equal(repositories.issues.get("issue-1")?.title, "Persist");
    assert.deepEqual(repositories.listComments("issue-1").map((row) => row.body), ["keep me"]);
    assert.deepEqual(repositories.listDocumentRevisions("issue-1", "plan").map((row) => row.revision), [1, 2]);
    assert.equal(repositories.listHeartbeats("agent-1").length, 1);
    assert.equal(repositories.listWakeups().length, 1);
    assert.equal(repositories.listRunEvents("run-1").length, 1);
    assert.equal(repositories.listApprovals("issue-1").length, 1);
    assert.deepEqual(repositories.listActivity("issue", "issue-1").map((row) => row.action), ["issue.checked_out", "completed"]);
    await database.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy JSON migration is idempotent and creates a recoverable backup", async () => {
  const dir = await fixture();
  const file = path.join(dir, "nexotao.sqlite");
  try {
    await writeFile(path.join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "Legacy", path: dir, mode: "multi", agents: [], createdAt: 1 }] }));
    await writeFile(path.join(dir, "agents.json"), JSON.stringify({ agents: [{ id: "a", projectId: "p", name: "Lead", role: "lead", scope: "Lead", reportsTo: null, createdAt: 2 }] }));
    await writeFile(path.join(dir, "issues.json"), JSON.stringify({ issues: [{ id: "i", projectId: "p", ref: "NX-1", title: "Legacy issue", detail: "kept", parentId: null, assigneeAgentId: "a", createdByAgentId: "a", status: "todo", stage: "execute", blockedBy: [], runId: null, summary: "", createdAt: 3, updatedAt: 3 }] }));
    let database = await openDatabase(file);
    assert.equal(new ControlPlaneRepositories(database).issues.get("i")?.description, "kept");
    await database.close();
    database = await openDatabase(file);
    assert.equal(new ControlPlaneRepositories(database).issues.list("p").length, 1);
    const backups = await readdir(path.join(dir, "backups"));
    assert.equal(backups.length, 1);
    assert.match(await readFile(path.join(dir, "backups", backups[0], "issues.json"), "utf8"), /Legacy issue/);
    await database.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
