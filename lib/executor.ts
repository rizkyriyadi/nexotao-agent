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
  awaitsReview, RUN_EXCLUSION_EVENT_TYPE, RUN_RESULT_EVENT_TYPE, RUN_REVIEW_EVENT_TYPE,
  RUN_SNAPSHOT_EVENT_TYPE, RUN_SUMMARY_EVENT_TYPE, settledIssueStatus,
} from "./run-transcript";
import { DurableHeartbeatRuntime, type HeartbeatContext } from "./heartbeat-runtime";
import { capture, changedSince, sweepSnapshots } from "./run-snapshot";
import { agentWriteGuard } from "./run-guards";
import { isBlockerResolved } from "./blocker-attention";
import { hasUnansweredFollowUp, openConversation } from "./follow-ups";

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
  // Boot is the one moment nothing is mid-write, so it is where a snapshot left
  // by a process that died — the case no post-run sweep can ever reach — gets
  // collected. Fire-and-forget: startup must not wait on git.
  void sweepRunSnapshots();
}

/** Collect the snapshot refs of runs nobody is waiting on any more.
 *
 *  One ref is minted per run and nothing else ever removes them, so without this
 *  a task the user followed up on a dozen times leaves a dozen dangling commits
 *  pinned in their repository for good. Refs whose task is still parked in
 *  review are held — that is precisely what keeps Revert on offer — and the rest
 *  age out. */
async function sweepRunSnapshots(projectId?: string) {
  try {
    const repositories = new ControlPlaneRepositories(await getDatabase());
    const held = repositories.snapshotRunIdsInReview(projectId);
    for (const project of await listProjects()) {
      if (projectId && project.id !== projectId) continue;
      await sweepSnapshots(expandHome(project.path), held).catch(() => undefined);
    }
  } catch {
    // Housekeeping. A repository that will not release a ref is untidy, not
    // broken, and must never take a run down with it.
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
    run.push({ type: "run", runId });
    run.push({ type: "status", status: "running" });

    // The agent handles the task directly in the mode the user picked: `ask`
    // answers read-only, `plan` writes a plan read-only, `agent` builds it in
    // the user's own project folder.
    const mode: import("./agent").IssueAgentMode =
      issue.runMode === "ask" ? "lead-ask" : issue.runMode === "plan" ? "lead-plan-doc" : "lead-execute";
    const writesFiles = mode === "lead-execute";
    if (heartbeat.signal.aborted) cancel();

    // One folder, always: the one the user has open. There is no second place to
    // execute any more, which is the whole point — the run's work is immediately
    // visible in their editor, buildable, and testable.
    const executionRoot = root;
    const refused = new Set<string>();
    const beforeMutation = writesFiles ? agentWriteGuard((file) => refused.add(file)) : undefined;

    // Build the conversation — the original request, then any follow-up messages
    // — and remember which of them this run is answering, so a message that
    // arrives while it works is recognised as still owed a reply.
    const { messages, answered } = openConversation(issue, repositories.listComments(issueId));
    const unanswered = () => hasUnansweredFollowUp(repositories.listComments(issueId), answered);

    let result: { text: string; summary: string; completion: import("./run-transcript").RunCompletion } =
      { text: "", summary: "", completion: "complete" };
    // Set when the run changed files and the user has asked to look before the
    // task closes. The files are already in their folder either way — this only
    // decides whether the task parks in review or finishes.
    let awaitingReview = false;
    try {
      // Record the folder before a single byte is written, so Revert has
      // somewhere to go back to. Deliberately outside the failure path: capture
      // never throws, and a run without a safety net is still a run — it just
      // says so. The old worktree provisioning had the opposite contract,
      // rightly, because a failure there meant nowhere to execute at all.
      if (writesFiles) {
        const snapshot = await capture(root, runId);
        if (snapshot.available) {
          await repositories.recordSnapshot(runId, snapshot.commit, snapshot.head).catch(() => null);
        } else {
          // Said out loud rather than swallowed: without this the run edits the
          // user's folder with no way back and nothing anywhere admits it.
          await heartbeat.emit(RUN_SNAPSHOT_EVENT_TYPE, { reason: snapshot.reason, detail: snapshot.detail, thread: "lead" });
        }
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
        // Refused writes are the one outcome the changes notice below cannot
        // describe. A run whose every attempted write was refused changes
        // nothing, so the user would be told nothing at all: no notice, an
        // unchanged folder, and a summary claiming the files were written.
        if (refused.size) {
          const files = [...refused].join(", ");
          const notice = `\n\n> Not written — agent instruction files are local-only and a run may not edit them: ${files}.`;
          await heartbeat.emit(RUN_EXCLUSION_EVENT_TYPE, { files: [...refused], thread: "lead" });
          result.text += notice;
          if (result.summary) result.summary += notice;
        }
        // The files are already in the user's folder — the agent wrote them
        // there. What is left to decide is whether the task may close on the
        // agent's own say-so, and that is the user's setting: "review" parks it
        // until they have looked, "auto" finishes it and leaves the diff and
        // Revert available anyway.
        //
        // Told in the same three places a refusal is, because each is read by a
        // different surface and none can be reached from the others at this
        // point: the transcript reads durable events, the board reads the issue
        // summary, and the answer text is what a follow-up run sees as the prior
        // turn.
        const snapshotRow = repositories.getHeartbeat(runId);
        const changes = snapshotRow?.snapshotCommit
          ? await changedSince(root, snapshotRow.snapshotCommit, runId).catch(() => [])
          : [];
        if (awaitsReview(changes.length, (await getConfig()).reviewMode)) {
          awaitingReview = true;
          await heartbeat.emit(RUN_REVIEW_EVENT_TYPE, {
            files: changes.slice(0, 50).map((change) => change.path), thread: "lead",
          });
          const notice = `\n\n> Waiting for your review — ${changes.length} file${changes.length === 1 ? "" : "s"} changed in your project folder. `
            + `Keep them, or revert them back to how they were before this run.`;
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
      // A failed run does not make the message that arrived during it any less
      // unanswered. Hardcoding `false` here filed the task in review with the
      // follow-up sitting in the thread and nothing left to ever read it.
      if (run.cancelled) await I.updateIssue(issueId, { status: "cancelled", summary: "Cancelled by user" }, { type: "agent", id: agent.id, runId });
      else await onIssueFinished(projectId, issue, agent, result, false, unanswered, false);
      throw e;
    } finally {
      await eventWrites;
      stopMirroring();
      heartbeat.signal.removeEventListener("abort", cancel);
    }
    // A follow-up message that landed while this run was executing isn't answered
    // yet — reopen the task so the lead picks it up in a fresh run.
    await onIssueFinished(projectId, issue, agent, result, true, unanswered, awaitingReview);
}

async function onIssueFinished(
  projectId: string,
  issue: I.Issue,
  agent: I.Agent,
  result: { text: string; summary?: string; completion?: import("./run-transcript").RunCompletion },
  ok: boolean,
  unanswered: () => boolean,
  awaitingReview: boolean,
) {
  // An agent that ran out of steps was still mid-task. Calling that "done" is
  // what made finished-looking tasks trail off mid-sentence with nothing to
  // show for them; it goes to review instead, where the user can continue it.
  const truncated = result.completion === "truncated";
  const status = settledIssueStatus({ ok, truncated, requeue: unanswered(), review: awaitingReview });
  // The closing report is what the user reads on the board, so it is preferred
  // over the raw stream of mid-task thinking that used to land here.
  const summary = result.summary?.trim() || result.text;
  await I.updateIssue(issue.id, { status, summary }, { type: "agent", id: agent.id, runId: issue.runId });
  // One window is left and it is the narrowest one: a message posted between the
  // check above and the write. `reopen` sees a task that is still `in_progress`
  // and leaves it for this run to notice — and this run has already decided. So
  // the last thing the run does before it stops looking is look once more, now
  // that the task is no longer checked out to it and a re-open would stick.
  if (status === "done" && unanswered()) {
    await I.reopenIssue(issue.id, { type: "system", runId: issue.runId }).catch(() => null);
  }
  // Record the run, then fold it into the work-history graph incrementally. Both
  // are fire-and-forget so run completion isn't slowed or blocked by indexing.
  addAgentRun(projectId, { agent: agent.name, task: issue.title, summary: summary.slice(0, 400), ok: ok && !truncated })
    .then((run) => appendRunToWorkGraph(projectId, { run, issue: { identifier: issue.ref, title: issue.title, status } }))
    .catch(() => {});
  // Re-index the canonical root. Every run that wrote anything wrote it here,
  // so unlike the worktree era this is a real refresh rather than a no-op
  // waiting on an approval. Fire-and-forget for the same reason as the work
  // graph above.
  getProject(projectId)
    .then((project) => (project ? refreshCodeIndex(projectId, project.path, { mode: "fast" }) : null))
    .catch(() => {});
  // Collect the snapshot refs of runs nobody is waiting on. A task parked in
  // review holds its own, so a follow-up conversation reclaims the refs of the
  // exchanges before it instead of adding to them.
  void sweepRunSnapshots(projectId);
  tick(projectId);
}
