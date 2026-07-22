// The control plane. Turns each prompt into a task (issue) for the single lead
// agent, then drives its run lifecycle: the lead handles the task in the chosen
// mode (ask / plan / agent), and follow-up messages reopen the same task so the
// conversation continues.
import { promises as fs } from "fs";
import { getConfig } from "./config";
import { getProject, addAgentRun } from "./store";
import { appendRunToWorkGraph } from "./graphify";
import { expandHome } from "./paths";
import { DEFAULT_MODEL } from "./nexotao";
import { createRun, type RunEvent } from "./run-manager";
import { runIssueAgent } from "./agent";
import * as I from "./issues";
import { getDatabase } from "./db/database";
import { ControlPlaneRepositories, type ClaimedHeartbeat, type WakeupReason } from "./db/repositories";
import { RunEventDomainError } from "./run-events";
import { DurableHeartbeatRuntime, type HeartbeatContext } from "./heartbeat-runtime";
import { GitWorkspaceManager } from "./git-workspace";

let runtimePromise: Promise<DurableHeartbeatRuntime> | undefined;
async function heartbeatRuntime() {
  runtimePromise ??= getDatabase().then((database) => {
    const repositories = new ControlPlaneRepositories(database);
    return new DurableHeartbeatRuntime(repositories, startIssue);
  });
  return runtimePromise;
}

async function ctx(projectId: string) {
  const cfg = await getConfig();
  const project = await getProject(projectId);
  const root = expandHome(project?.path || process.cwd());
  await fs.mkdir(root, { recursive: true }).catch(() => {});
  return { apiKey: cfg.apiKey || "", model: cfg.model || DEFAULT_MODEL, root };
}

/** Create the root issue for a goal and start the run. The run mode (chosen in
 *  the control panel) decides how the lead handles it: `agent` builds directly,
 *  `plan` writes a plan, `ask` just answers. */
export async function submitGoal(projectId: string, text: string, mode: I.RunMode = "agent", idempotencyKey?: string): Promise<I.Issue> {
  let lead = await I.leadAgent(projectId);
  if (!lead) {
    const project = await getProject(projectId);
    const seeded = await I.seedAgents(projectId, project?.agents ?? []);
    lead = seeded.find((a) => a.role === "lead") ?? null;
  }
  const root = await I.createIssue({
    projectId, title: text, detail: text,
    assigneeAgentId: lead?.id ?? null, createdByAgentId: null,
    status: lead ? "todo" : "backlog", stage: "execute", runMode: mode, idempotencyKey,
  });
  tick(projectId);
  return root;
}

/** Evaluate all issues and start any that are ready (assigned, unblocked, idle). */
export async function tick(projectId: string) {
  const issues = await I.listIssues(projectId);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const runtime = await heartbeatRuntime();
  for (const it of issues) {
    if (!it.assigneeAgentId) continue;
    if (it.status !== "todo" && it.status !== "blocked") continue;
    const unmet = it.blockedBy.filter((bid) => byId.get(bid)?.status !== "done");
    if (unmet.length) {
      if (it.status !== "blocked") I.updateIssue(it.id, { status: "blocked" }).catch(() => {});
      continue;
    }
    const ready = it.status === "blocked" ? await I.updateIssue(it.id, { status: "todo" }) : it;
    if (!ready) continue;
    await runtime.enqueue({
      agentId: ready.assigneeAgentId!, issueId: ready.id,
      reason: it.status === "blocked" ? "dependency" : "assignment",
      eventId: `${ready.stage}:${ready.updatedAt}`,
    });
  }
}

export async function triggerHeartbeat(input: { agentId: string; issueId?: string | null; reason: WakeupReason; eventId: string; availableAt?: number }) {
  return (await heartbeatRuntime()).enqueue(input);
}

export async function cancelHeartbeat(runId: string, reason?: string) {
  return (await heartbeatRuntime()).cancel(runId, reason);
}

export async function retryHeartbeat(runId: string) {
  return (await heartbeatRuntime()).retry(runId, Date.now());
}


function durableEvent(event: RunEvent): [string, unknown] | null {
  switch (event.type) {
    case "text": return ["reasoning_summary", { text: event.text, thread: event.thread }];
    case "tool_use": return ["tool_call", { id: event.id, name: event.name, input: event.input, thread: event.thread }];
    case "approval": return ["approval_wait", { id: event.id, name: event.name, input: event.input, thread: event.thread }];
    case "tool_result": return ["tool_result", {
      id: event.id, name: event.name, ok: event.ok, display: event.display, kind: event.kind,
      file: event.file, content: event.content, output: event.output, thread: event.thread,
    }];
    case "usage": return ["usage", { inputTokens: event.inputTokens, outputTokens: event.outputTokens, thread: event.thread }];
    case "thread_created": return ["status", { status: "thread_created", ...event }];
    case "thread_status": return ["status", { ...event }];
    default: return null;
  }
}
async function startIssue(job: ClaimedHeartbeat, heartbeat: HeartbeatContext) {
    const issueId = job.wakeup.issueId;
    if (!issueId) throw new Error("Heartbeat has no issue to execute");
    const candidate = await I.getIssue(issueId);
    if (!candidate?.assigneeAgentId) throw new Error(`Issue ${issueId} has no assignee`);
    const projectId = candidate.projectId;
    const runId = heartbeat.runId;
    const issue = await I.claimIssue(issueId, job.wakeup.agentId, runId); // atomic in_progress + lock
    if (!issue) return;
    const agent = issue.assigneeAgentId ? await I.getAgent(issue.assigneeAgentId) : null;
    if (!agent) { await I.releaseIssue(issueId, job.wakeup.agentId, runId, "assignee_missing"); return; }

    const { apiKey, model: defaultModel, root } = await ctx(projectId);
    // Per-role model routing: prefer the agent's recommended model (pinned by a
    // marketplace blueprint) over the project-wide default.
    const model = (await I.getAgentModel(agent.id)) ?? defaultModel;
    const database = await getDatabase();
    const repositories = new ControlPlaneRepositories(database);
    const workspaceManager = new GitWorkspaceManager(repositories);
    const run = createRun(runId, undefined, { kind: "chat", title: issue.title, projectId });
    let eventWrites = Promise.resolve();
    const stopMirroring = run.subscribe((event) => {
      const durable = durableEvent(event);
      if (!durable) return;
      eventWrites = eventWrites.then(() => heartbeat.emit(durable[0], durable[1])).catch((error) => {
        if (error instanceof RunEventDomainError && error.code === "terminal") return;
        throw error;
      });
    });
    const cancel = () => run.cancel(heartbeat.signal.reason instanceof Error ? heartbeat.signal.reason.message : "Cancelled by runtime");
    heartbeat.signal.addEventListener("abort", cancel, { once: true });
    const startedAt = Date.now();
    run.push({ type: "run", runId });
    run.push({ type: "status", status: "running" });

    // A single lead agent handles the task directly in the mode the user picked:
    // `ask` answers read-only, `plan` writes a plan read-only, `agent` builds it
    // in an isolated workspace.
    const mode: import("./agent").IssueAgentMode =
      issue.runMode === "ask" ? "lead-ask" : issue.runMode === "plan" ? "lead-plan-doc" : "lead-execute";
    const writesFiles = mode === "lead-execute";
    if (heartbeat.signal.aborted) cancel();

    let executionRoot = root;
    let beforeMutation: ((tool: { name: string; input: unknown }) => Promise<void>) | undefined;
    if (writesFiles) {
      const assignment = await workspaceManager.provision({ projectId, issueId, identifier: issue.ref, runId, repositoryPath: root });
      executionRoot = assignment.workspacePath;
      beforeMutation = workspaceManager.mutationGuard(issueId, runId);
    }

    // Build the conversation: the original request, then any follow-up messages
    // (with the previous run's summary as the assistant turn between them) so the
    // lead continues the same task instead of starting over.
    const followUps = repositories.listComments(issueId)
      .filter((c) => c.authorType === "user")
      .sort((a, b) => a.createdAt - b.createdAt);
    const messages: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: issue.detail || issue.title },
    ];
    if (followUps.length) {
      if (issue.summary) messages.push({ role: "assistant", content: issue.summary });
      for (const c of followUps) messages.push({ role: "user", content: c.body });
    }

    let result: { text: string } = { text: "" };
    try {
      result = await runIssueAgent({
        run, apiKey, model, root: executionRoot, mode, agentName: agent.name, messages, beforeMutation,
      });
      if (mode === "lead-execute") {
        // Persist the work to the isolated worktree. The commit is an internal
        // implementation detail — the user sees the agent's own summary, not a
        // raw commit hash appended to the answer.
        await workspaceManager.finalizeCommit(issueId, runId, issue.ref);
      } else if (mode === "lead-plan-doc") {
        // Persist the plan as the issue's `plan` document so it's reviewable and
        // the user can re-run in Agent mode to execute it.
        await repositories.putDocument({ issueId, key: "plan", body: result.text, createdByType: "agent", createdById: agent.id }).catch(() => {});
      }
      await eventWrites;
      await heartbeat.emit("output", { text: result.text, thread: "lead" });
      run.push({ type: "done" });
    } catch (e: any) {
      run.push({ type: "error", error: String(e?.message ?? e) });
      result = { text: `Failed: ${String(e?.message ?? e)}` };
      if (run.cancelled) await I.updateIssue(issueId, { status: "cancelled", summary: "Cancelled by user" }, { type: "agent", id: agent.id, runId });
      else await onIssueFinished(projectId, issue, agent, result, false, false);
      throw e;
    } finally {
      await eventWrites;
      stopMirroring();
      heartbeat.signal.removeEventListener("abort", cancel);
    }
    // A follow-up message that landed while this run was executing isn't answered
    // yet — reopen the task so the lead picks it up in a fresh run.
    const queued = repositories.listComments(issueId).some((c) => c.authorType === "user" && c.createdAt > startedAt);
    await onIssueFinished(projectId, issue, agent, result, true, queued);
}

async function onIssueFinished(
  projectId: string,
  issue: I.Issue,
  agent: I.Agent,
  result: { text: string },
  ok: boolean,
  requeue: boolean,
) {
  const status = ok ? (requeue ? "todo" : "done") : "in_review";
  await I.updateIssue(issue.id, { status, summary: result.text }, { type: "agent", id: agent.id, runId: issue.runId });
  // Record the run, then fold it into the work-history graph incrementally. Both
  // are fire-and-forget so run completion isn't slowed or blocked by indexing.
  addAgentRun(projectId, { agent: agent.name, task: issue.title, summary: result.text.slice(0, 400), ok })
    .then((run) => appendRunToWorkGraph(projectId, { run, issue: { identifier: issue.ref, title: issue.title, status } }))
    .catch(() => {});
  tick(projectId);
}
