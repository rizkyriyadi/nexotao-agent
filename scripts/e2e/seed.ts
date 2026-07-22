// Seeds a deterministic control-plane fixture into NEXOTAO_DATA_DIR so the E2E
// runner can drive real orchestration flows (delegation, dependencies, approval,
// cancel, retry, review/done, restart) against the running server WITHOUT a live
// Gateway. Prints the created identifiers as JSON on stdout for the runner.
import { randomUUID } from "node:crypto";
import { saveConfig } from "../../lib/config";
import { addProject } from "../../lib/store";
import { createIssue, seedAgents } from "../../lib/issues";
import { getDatabase } from "../../lib/db/database";
import { approvals } from "../../lib/db/schema";
import { ControlPlaneRepositories } from "../../lib/db/repositories";

async function main() {
  const now = Date.now();
  const project = await addProject({ name: "E2E Beta", path: process.env.NEXOTAO_PROJECT_PATH || process.cwd(), mode: "multi", agents: [{ name: "Builder", scope: "Implement" }] });
  await saveConfig({ apiKey: "e2e-" + "k".repeat(40), model: "nexotao-default", onboarded: true, activeProjectId: project.id });

  const [lead, worker] = await seedAgents(project.id, project.agents ?? []);

  // Root issue for delegation + dependency flows.
  const root = await createIssue({ projectId: project.id, title: "Ship public beta", assigneeAgentId: lead.id, status: "backlog", actor: { type: "user" } });
  // A second issue used as a dependency blocker.
  const blocker = await createIssue({ projectId: project.id, title: "Cut release branch", assigneeAgentId: worker.id, status: "todo", actor: { type: "user" } });
  // An issue already in review, for the review -> done transition flow.
  const review = await createIssue({ projectId: project.id, title: "Verify smoke matrix", assigneeAgentId: worker.id, status: "in_review", actor: { type: "user" } });
  // An assigned issue used to exercise re-invoke (retry).
  const retry = await createIssue({ projectId: project.id, title: "Rebuild package", assigneeAgentId: worker.id, status: "backlog", actor: { type: "user" } });

  const database = await getDatabase();
  const repositories = new ControlPlaneRepositories(database);

  // A non-terminal heartbeat run to cancel through /api/run/cancel.
  const cancelRun = await repositories.createHeartbeat({ agentId: worker.id, issueId: root.id, source: "invoke", status: "waiting", startedAt: now, updatedAt: now });

  // A pending, non-execution approval card on the root issue for the approve flow.
  const approvalId = randomUUID();
  await database.write((db) => db.insert(approvals).values({
    id: approvalId, type: "plan", projectId: project.id, issueId: root.id,
    payload: { summary: "Approve the staged rollout plan", phase: "beta" }, status: "pending", createdAt: now,
  }).run());

  process.stdout.write(JSON.stringify({
    projectId: project.id, lead: lead.id, worker: worker.id,
    root: root.id, blocker: blocker.id, review: review.id, retry: retry.id,
    cancelRunId: cancelRun.id, approvalId,
  }) + "\n");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
