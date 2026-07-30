// Seeds a deterministic control-plane fixture into NEXOTAO_DATA_DIR so the E2E
// runner can drive real control-plane flows (dependencies, approval, cancel,
// retry, review/done, restart) against the running server WITHOUT a live
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
  const project = await addProject({ name: "E2E Beta", path: process.env.NEXOTAO_PROJECT_PATH || process.cwd() });
  await saveConfig({ apiKey: "e2e-" + "k".repeat(40), model: "nexotao-default", onboarded: true, activeProjectId: project.id });

  const [agent] = await seedAgents(project.id);

  // Root issue for the dependency flow.
  const root = await createIssue({ projectId: project.id, title: "Ship public beta", assigneeAgentId: agent.id, status: "backlog", actor: { type: "user" } });
  // A second issue used as a dependency blocker.
  const blocker = await createIssue({ projectId: project.id, title: "Cut release branch", assigneeAgentId: agent.id, status: "todo", actor: { type: "user" } });
  // An issue already in review, for the review -> done transition flow.
  const review = await createIssue({ projectId: project.id, title: "Verify smoke matrix", assigneeAgentId: agent.id, status: "in_review", actor: { type: "user" } });
  // An assigned issue used to exercise re-invoke (retry).
  const retry = await createIssue({ projectId: project.id, title: "Rebuild package", assigneeAgentId: agent.id, status: "backlog", actor: { type: "user" } });

  const database = await getDatabase();
  const repositories = new ControlPlaneRepositories(database);

  // A non-terminal heartbeat run to cancel through /api/run/cancel.
  const cancelRun = await repositories.createHeartbeat({ agentId: agent.id, issueId: root.id, source: "invoke", status: "waiting", startedAt: now, updatedAt: now });

  // The shape of the reported "cancelled but still shows as running" bug: a run
  // that holds its issue's checkout, with nothing in memory to abort. Cancelling
  // it must release the issue, not just close the run row.
  const stuck = await createIssue({ projectId: project.id, title: "Cancel mid-flight", assigneeAgentId: agent.id, status: "todo", actor: { type: "user" } });
  const stuckRun = await repositories.createHeartbeat({ agentId: agent.id, issueId: stuck.id, source: "invoke", status: "running", startedAt: now, updatedAt: now });
  await repositories.checkoutIssue(stuck.id, agent.id, stuckRun.id);

  // A pending, non-execution approval card on the root issue for the approve flow.
  const approvalId = randomUUID();
  await database.write((db) => db.insert(approvals).values({
    id: approvalId, type: "plan", projectId: project.id, issueId: root.id,
    payload: { summary: "Approve the staged rollout plan", phase: "beta" }, status: "pending", createdAt: now,
  }).run());

  /* A finished run carrying one of every transcript shape — prose, a grouped
     repeat of one tool, a diff, a shell command, a failure and a denial. This is
     what the transcript redesign is actually judged on, and without it the E2E
     screenshots only ever show empty runs. */
  const rich = await createIssue({ projectId: project.id, title: "Tidy the run transcript", assigneeAgentId: agent.id, status: "todo", actor: { type: "user" } });
  const richRun = await repositories.createHeartbeat({ agentId: agent.id, issueId: rich.id, source: "invoke", status: "running", startedAt: now, updatedAt: now });
  const say = (text: string) => repositories.appendHeartbeatEvent(richRun.id, "reasoning_summary", { text, thread: "lead" });
  const call = (id: string, name: string, input: unknown) => repositories.appendHeartbeatEvent(richRun.id, "tool_call", { id, name, input });
  const result = (id: string, output: string, ok = true) => repositories.appendHeartbeatEvent(richRun.id, "tool_result", { id, output, ok });

  await say("I'll look at how the transcript renders today, then tighten it up.\n\n");
  await call("t1", "list_dir", { path: "components/task" });
  await result("t1", ["ActivityIndicator.tsx", "ToolCall.tsx", "TaskView.tsx", "transcript.tsx", "use-run-stream.ts"].join("\n"));
  // Two reads in a row — these collapse behind an ×2 group.
  await call("t2", "read_file", { path: "components/task/transcript.tsx" });
  await result("t2", "export function Transcript({ log, phase }) {\n  const blocks = toBlocks(log);\n}");
  await call("t3", "read_file", { path: "components/task/use-run-stream.ts" });
  await result("t3", "export function useRunStream(runId) { /* … */ }");
  await say("The tool rows dump raw JSON, so a long run reads as noise. Switching them to one-line summaries.\n\n");
  await call("t4", "edit_file", {
    path: "components/task/transcript.tsx",
    old_str: "  const waiting = status === \"queued\" ? \"Queued\" : \"Working…\";\n  return <pre>{JSON.stringify(log)}</pre>;",
    new_str: "  const blocks = toBlocks(log);\n  return blocks.map(renderBlock);",
  });
  await result("t4", "Edited components/task/transcript.tsx");
  await call("t5", "bash", { command: "npm test -- transcript" });
  await result("t5", "PASS tests/transcript.test.ts\n\nTests: 12 passed, 12 total");
  await call("t6", "grep", { pattern: "JSON.stringify\\(log\\)" });
  await result("t6", "no matches found", false);
  await call("t7", "bash", { command: "rm -rf node_modules" });
  await result("t7", "The user denied this action.", false);
  await say("Done — tool calls now read as sentences, and repeated calls fold into a single group.");
  await repositories.completeHeartbeat(richRun.id, "succeeded", { status: "succeeded" });

  process.stdout.write(JSON.stringify({
    projectId: project.id, agent: agent.id,
    root: root.id, blocker: blocker.id, review: review.id, retry: retry.id,
    cancelRunId: cancelRun.id, approvalId,
    stuck: stuck.id, stuckRunId: stuckRun.id,
    rich: rich.id, richRunId: richRun.id,
  }) + "\n");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
