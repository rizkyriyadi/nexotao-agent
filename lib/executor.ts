// The control plane. Turns each prompt into a task (issue) for the agent, then
// drives its run lifecycle: the agent handles the task in the chosen mode
// (ask / plan / agent), and follow-up messages reopen the same task so the
// conversation continues.
import { promises as fs } from "fs";
import { getConfig } from "./config";
import { getProject, addAgentRun, listProjects } from "./store";
import { appendRunToWorkGraph } from "./graphify";
import { refreshCodeIndex } from "./code-memory";
import { expandHome } from "./paths";
import { DEFAULT_MODEL } from "./nexotao";
import { createRun, type RunEvent } from "./run-manager";
import { runIssueAgent } from "./agent";
import * as I from "./issues";
import { getDatabase } from "./db/database";
import { ControlPlaneRepositories, type ClaimedHeartbeat, type WakeupReason } from "./db/repositories";
import { RunEventDomainError } from "./run-events";
import {
  RUN_INTEGRATION_EVENT_TYPE, RUN_RESULT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE,
  settledIssueStatus,
} from "./run-transcript";
import { DurableHeartbeatRuntime, type HeartbeatContext } from "./heartbeat-runtime";
import { GitWorkspaceManager } from "./git-workspace";
import { isBlockerResolved } from "./blocker-attention";

/** How long a run start will wait for its code index to catch up before going
 *  ahead anyway. A warm re-index measures ~0.1–0.6 s, so this is nearly never
 *  reached; it exists so a cold first index of a large repo cannot stall a run. */
const INDEX_WAIT_MS = 1_500;

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
 *  the control panel) decides how the agent handles it: `agent` builds directly,
 *  `plan` writes a plan, `ask` just answers. */
export async function submitGoal(projectId: string, text: string, mode: I.RunMode = "agent", idempotencyKey?: string, model?: string | null): Promise<I.Issue> {
  let lead = await I.leadAgent(projectId);
  if (!lead) {
    const seeded = await I.seedAgents(projectId);
    lead = seeded.find((a) => a.role === "lead") ?? null;
  }
  const root = await I.createIssue({
    projectId, title: text, detail: text,
    assigneeAgentId: lead?.id ?? null,
    status: lead ? "todo" : "backlog", stage: "execute", runMode: mode, model: model ?? null, idempotencyKey,
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
    // Must match the lifecycle's own rule (done *or* cancelled resolves a
    // blocker); disagreeing here would re-block work the lifecycle just freed.
    const unmet = it.blockedBy.filter((bid) => !isBlockerResolved(byId.get(bid)?.status ?? ""));
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

/** Pick up work that was queued when the process last went down. Constructing
 *  the runtime recovers orphaned heartbeats and drains the queue; ticking every
 *  project re-enqueues anything that is ready but has no wakeup at all. */
export async function resumeQueuedWork() {
  const runtime = await heartbeatRuntime();
  await runtime.initialize();
  for (const project of await listProjects()) await tick(project.id).catch(() => {});
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
    case "summary": return [RUN_SUMMARY_EVENT_TYPE, { text: event.text, thread: event.thread }];
    case "tool_use": return ["tool_call", { id: event.id, name: event.name, input: event.input, thread: event.thread }];
    case "approval": return ["approval_wait", { id: event.id, name: event.name, input: event.input, thread: event.thread }];
    case "tool_result": return ["tool_result", {
      id: event.id, name: event.name, ok: event.ok, display: event.display, kind: event.kind,
      file: event.file, content: event.content, output: event.output, thread: event.thread,
    }];
    case "usage": return ["usage", { inputTokens: event.inputTokens, outputTokens: event.outputTokens, thread: event.thread }];
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
    // Model routing, most specific first: the model chosen for this conversation,
    // then the agent's recommended model (pinned by a marketplace blueprint),
    // then the project-wide default.
    const model = issue.model ?? (await I.getAgentModel(agent.id)) ?? defaultModel;
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

    // The agent handles the task directly in the mode the user picked: `ask`
    // answers read-only, `plan` writes a plan read-only, `agent` builds it in an
    // isolated workspace.
    const mode: import("./agent").IssueAgentMode =
      issue.runMode === "ask" ? "lead-ask" : issue.runMode === "plan" ? "lead-plan-doc" : "lead-execute";
    const writesFiles = mode === "lead-execute";
    if (heartbeat.signal.aborted) cancel();

    let executionRoot = root;
    let beforeMutation: ((tool: { name: string; input: unknown }) => Promise<void>) | undefined;

    // Build the conversation: the original request, then any follow-up messages
    // (with the previous run's summary as the assistant turn between them) so the
    // agent continues the same task instead of starting over.
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

    let result: { text: string; summary: string; completion: import("./run-transcript").RunCompletion } =
      { text: "", summary: "", completion: "complete" };
    try {
      // Provision the isolated worktree inside the run's try/catch so a
      // preparation failure (e.g. `git worktree add`) is reported as a failed
      // run and transitions the issue out of `in_progress`, instead of leaving
      // it stranded as "running" while the run itself is already failed.
      if (writesFiles) {
        const assignment = await workspaceManager.provision({ projectId, issueId, identifier: issue.ref, runId, repositoryPath: root });
        executionRoot = assignment.workspacePath;
        beforeMutation = workspaceManager.mutationGuard(issueId, runId);
      }
      // The agent's first instruction is to call graph_query before reading
      // files, so the index wants to be current *before* the run starts, not
      // after. We wait on a deadline rather than on the refresh: a warm
      // re-index is well under a second, but a cold first index of a large repo
      // must not hold up the run — it keeps going in the background and the
      // next trigger joins it instead of starting over.
      await Promise.race([
        refreshCodeIndex(projectId, root, { mode: "fast" }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, INDEX_WAIT_MS).unref()),
      ]);
      result = await runIssueAgent({
        run, apiKey, model, root: executionRoot, mode, agentName: agent.name, messages, beforeMutation,
      });
      if (mode === "lead-execute") {
        // Persist the work to the isolated worktree, then fast-forward it into the
        // user's own branch. The commit is an internal implementation detail — the
        // user sees the agent's own summary, not a raw commit hash — but the files
        // are not: a run that reports "done" while the project folder is untouched
        // is indistinguishable from one that did nothing.
        await workspaceManager.finalizeCommit(issueId, runId, issue.ref);
        const integration = await workspaceManager.integrate(runId);
        // A refusal is not a failed run: the work is committed and recoverable, so
        // the only thing at stake is that the user knows where it is. Three places
        // need telling, because each is read by a different surface and none of
        // them can be reached from the others at this point: the transcript reads
        // durable events (and every event the agent wrote was written before
        // integration was even attempted), the board reads the issue summary, and
        // the answer text is what a follow-up run sees as the prior turn.
        if (integration.reason && integration.commit) {
          // A fourth reader, and the only one that outlives the run: the files
          // panel. The three below are all transcript-shaped — they answer "what
          // happened in this run?" — but the user's next question is "where are
          // my files?", asked from a folder view that has no run attached. That
          // needs the refusal recorded on the workspace itself, where a later
          // read can find it without replaying events.
          await repositories.markWorkspaceState(runId, "rejected", integration.reason).catch(() => {});
          await heartbeat.emit(RUN_INTEGRATION_EVENT_TYPE, {
            branch: integration.branch, reason: integration.reason, thread: "lead",
          });
          const notice = `\n\n> Your project folder was left as it is — ${integration.reason}. Merge it with \`git merge ${integration.branch}\`.`;
          result.text += notice;
          if (result.summary) result.summary += notice;
        }
      } else if (mode === "lead-plan-doc") {
        // Persist the plan as the issue's `plan` document so it's reviewable and
        // the user can re-run in Agent mode to execute it.
        await repositories.putDocument({ issueId, key: "plan", body: result.text, createdByType: "agent", createdById: agent.id }).catch(() => {});
      }
      await eventWrites;
      // Deliberately NOT an `output`/text event: every token above was already
      // persisted as a `reasoning_summary` delta, so a transcript that appended
      // this too would render the whole answer twice on replay.
      await heartbeat.emit(RUN_RESULT_EVENT_TYPE, {
        text: result.text, summary: result.summary, completion: result.completion, thread: "lead",
      });
      run.push({ type: "done" });
    } catch (e: any) {
      run.push({ type: "error", error: String(e?.message ?? e) });
      result = { text: `Failed: ${String(e?.message ?? e)}`, summary: "", completion: "complete" };
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
  result: { text: string; summary?: string; completion?: import("./run-transcript").RunCompletion },
  ok: boolean,
  requeue: boolean,
) {
  // An agent that ran out of steps was still mid-task. Calling that "done" is
  // what made finished-looking tasks trail off mid-sentence with nothing to
  // show for them; it goes to review instead, where the user can continue it.
  const truncated = result.completion === "truncated";
  const status = settledIssueStatus({ ok, truncated, requeue });
  // The closing report is what the user reads on the board, so it is preferred
  // over the raw stream of mid-task thinking that used to land here.
  const summary = result.summary?.trim() || result.text;
  await I.updateIssue(issue.id, { status, summary }, { type: "agent", id: agent.id, runId: issue.runId });
  // Record the run, then fold it into the work-history graph incrementally. Both
  // are fire-and-forget so run completion isn't slowed or blocked by indexing.
  addAgentRun(projectId, { agent: agent.name, task: issue.title, summary: summary.slice(0, 400), ok: ok && !truncated })
    .then((run) => appendRunToWorkGraph(projectId, { run, issue: { identifier: issue.ref, title: issue.title, status } }))
    .catch(() => {});
  // The run's work has just been fast-forwarded into the user's branch, so this
  // is where the new code lands in the canonical root. Fire-and-forget for the
  // same reason as the work graph above: nothing about finishing waits on it.
  getProject(projectId)
    .then((project) => (project ? refreshCodeIndex(projectId, project.path, { mode: "fast" }) : null))
    .catch(() => {});
  tick(projectId);
}
