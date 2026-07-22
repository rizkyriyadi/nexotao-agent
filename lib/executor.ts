// The control plane. Turns a goal into a root issue for the lead, then drives
// the whole delegation lifecycle: the lead plans + delegates (creating child
// issues), the executor wakes each assignee whose dependencies are met and runs
// it in parallel, and when all children finish it wakes the lead to integrate.
import { promises as fs } from "fs";
import { getConfig } from "./config";
import { getProject, addAgentRun } from "./store";
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

async function verificationCommands(root: string, configured: unknown) {
  if (Array.isArray(configured)) {
    const commands = configured.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (commands.length) return commands;
  }
  try {
    const manifest = JSON.parse(await fs.readFile(`${root}/package.json`, "utf8")) as { scripts?: Record<string, string> };
    const commands: string[] = [];
    if (manifest.scripts?.typecheck) commands.push("npm run typecheck");
    if (manifest.scripts?.test) commands.push("npm test");
    if (commands.length) return commands;
  } catch {}
  throw new Error("No verification commands are configured for lead integration");
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

    const { apiKey, model, root } = await ctx(projectId);
    const database = await getDatabase();
    const repositories = new ControlPlaneRepositories(database);
    const workspaceManager = new GitWorkspaceManager(repositories);
    const run = createRun(runId, undefined, { kind: "orchestrator", title: issue.title, projectId });
    let eventWrites = Promise.resolve();
    // Adapters report cumulative token usage per thread; track the max per thread
    // so the settled ledger row reflects the run's true total without double
    // counting the incremental updates.
    const usageByThread = new Map<string, { inputTokens: number; outputTokens: number }>();
    const stopMirroring = run.subscribe((event) => {
      if (event.type === "usage") {
        const key = event.thread ?? "main";
        const prev = usageByThread.get(key) ?? { inputTokens: 0, outputTokens: 0 };
        usageByThread.set(key, {
          inputTokens: Math.max(prev.inputTokens, event.inputTokens || 0),
          outputTokens: Math.max(prev.outputTokens, event.outputTokens || 0),
        });
      }
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

    // The control panel delegates the user's request straight to the lead, who
    // handles it in the mode the user picked: `ask` answers read-only, `plan`
    // writes a plan read-only, `agent` builds directly in an isolated workspace.
    // Legacy delegated children still run as `worker`, and a lead whose plan was
    // delegated still integrates via `lead-integrate`.
    const isLead = agent.role === "lead";
    const mode: import("./agent").IssueAgentMode = isLead
      ? (issue.stage === "integrate"
          ? "lead-integrate"
          : issue.runMode === "ask" ? "lead-ask" : issue.runMode === "plan" ? "lead-plan-doc" : "lead-execute")
      : "worker";
    const writesFiles = mode === "worker" || mode === "lead-execute" || mode === "lead-integrate";
    if (heartbeat.signal.aborted) cancel();

    let executionRoot = root;
    let beforeMutation: ((tool: { name: string; input: unknown }) => Promise<void>) | undefined;
    if (writesFiles) {
      const assignment = await workspaceManager.provision({ projectId, issueId, identifier: issue.ref, runId, repositoryPath: root });
      executionRoot = assignment.workspacePath;
      beforeMutation = workspaceManager.mutationGuard(issueId, runId);
    }

    // context the lead needs
    const workers = (await I.listAgents(projectId)).filter((a) => a.role === "worker").map((a) => ({ name: a.name, scope: a.scope }));
    let childrenReport = "";
    if (mode === "lead-integrate") {
      const kids = await I.childrenOf(issue.id);
      const childRows = kids.map((kid) => repositories.issues.get(kid.id)).filter((kid): kid is NonNullable<typeof kid> => Boolean(kid));
      const diffs = await workspaceManager.cherryPickChildren(issueId, runId, childRows.map((kid) => ({
        identifier: kid.identifier, workspaceCommit: kid.workspaceCommit, workspaceBaseCommit: kid.workspaceBaseCommit,
        verificationStatus: kid.verificationStatus,
      })));
      childrenReport = kids.map((kid, index) => `- ${kid.title}: ${kid.summary || "done"}\n${diffs[index] ?? ""}`).join("\n");
    }

    const onDelegate = async (tasks: any[]) => {
      const created: { assignee: string; title: string; id: string }[] = [];
      const nameToId: Record<string, string> = {};
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const worker = (await I.findAgentByName(projectId, String(t.assignee || ""))) ?? agent;
        const child = await I.createIssue({
          projectId, title: String(t.title || t.assignee || "Task"), detail: String(t.detail || t.title || ""),
          parentId: issue.id, assigneeAgentId: worker.id, createdByAgentId: agent.id, status: "todo", stage: "execute",
          idempotencyKey: `delegate:${runId}:${i}`, actor: { type: "agent", id: agent.id, runId },
        });
        const key = String(t.assignee || t.title).toLowerCase();
        nameToId[key] = child.id;
        nameToId[String(t.title).toLowerCase()] = child.id;
        created.push({ assignee: worker.name, title: child.title, id: child.id });
      }
      // wire dependencies (by worker/task name → issue id)
      for (let i = 0; i < tasks.length; i++) {
        const deps = (tasks[i].dependsOn ?? []).map((d: string) => nameToId[String(d).toLowerCase()]).filter(Boolean);
        if (deps.length) await I.updateIssue(created[i].id, { blockedBy: deps });
      }
      return { output: `Created ${created.length} sub-tasks:\n${created.map((c) => `- ${c.assignee}: ${c.title}`).join("\n")}` };
    };

    let result: { text: string; delegated: boolean } = { text: "", delegated: false };
    try {
      result = await runIssueAgent({
        run, apiKey, model, root: executionRoot, mode,
        agentName: agent.name, agentScope: agent.scope,
        goal: issue.title, detail: issue.detail, workers, childrenReport, onDelegate, beforeMutation,
      });
      if (mode === "worker" || mode === "lead-execute") {
        const finalized = await workspaceManager.finalizeCommit(issueId, runId, issue.ref);
        result.text = `${result.text}\n\nCommit: ${finalized.commit}`;
      } else if (mode === "lead-integrate") {
        const rawAgent = repositories.agents.get(agent.id);
        const commands = await verificationCommands(executionRoot, rawAgent?.runtimeConfig?.verificationCommands);
        const verified = await workspaceManager.verifyAndPromote(issueId, runId, issue.ref, commands);
        result.text = `${result.text}\n\nVerified commit: ${verified.commit}\n${verified.logs.join("\n\n")}`;
      } else if (mode === "lead-plan-doc") {
        // Persist the plan as the issue's `plan` document so it's reviewable and
        // the user can re-run in Agent mode to execute it.
        await repositories.putDocument({ issueId, key: "plan", body: result.text, createdByType: "agent", createdById: agent.id }).catch(() => {});
      }
      await eventWrites;
      await heartbeat.emit("output", { text: result.text, thread: mode === "worker" ? agent.name : "lead" });
      run.push({ type: "done" });
    } catch (e: any) {
      run.push({ type: "error", error: String(e?.message ?? e) });
      result = { text: `Failed: ${String(e?.message ?? e)}`, delegated: false };
      if (run.cancelled) await I.updateIssue(issueId, { status: "cancelled", summary: "Cancelled by user" }, { type: "agent", id: agent.id, runId });
      else await onIssueFinished(projectId, issue, agent, mode, result, false);
      throw e;
    } finally {
      await eventWrites;
      stopMirroring();
      heartbeat.signal.removeEventListener("abort", cancel);
      // Settle the run's usage onto the cost ledger. Idempotent per runId, so a
      // retry that reuses this runId overwrites rather than double-counts.
      if (usageByThread.size) {
        const usage = [...usageByThread.values()].map((tokens) => ({ model, ...tokens }));
        await repositories.settleRunCost({ runId, agentId: agent.id, usage }).catch(() => {});
      }
    }
    await onIssueFinished(projectId, issue, agent, mode, result, true);
}

async function onIssueFinished(
  projectId: string,
  issue: I.Issue,
  agent: I.Agent,
  mode: string,
  result: { text: string; delegated: boolean },
  ok: boolean,
) {
  if (mode === "lead-plan") {
    const kids = await I.childrenOf(issue.id);
    if (ok && result.delegated && kids.length) {
      // lead handed work to workers → wait in review, integrate later
      await I.updateIssue(issue.id, { status: "in_review", stage: "integrate", summary: result.text }, { type: "agent", id: agent.id, runId: issue.runId });
    } else {
      await I.updateIssue(issue.id, { status: ok ? "done" : "in_review", summary: result.text }, { type: "agent", id: agent.id, runId: issue.runId });
    }
  } else if (mode === "worker") {
    await I.updateIssue(issue.id, { status: ok ? "done" : "in_review", summary: result.text }, { type: "agent", id: agent.id, runId: issue.runId });
    addAgentRun(projectId, { agent: agent.name, task: issue.title, summary: result.text.slice(0, 400), ok }).catch(() => {});
    // if all of the parent's children are terminal, wake the lead to integrate
    if (issue.parentId) {
      const siblings = await I.childrenOf(issue.parentId);
      const allDone = siblings.every((s) => s.status === "done" || s.status === "cancelled" || s.status === "in_review");
      if (allDone) {
        const parent = await I.getIssue(issue.parentId);
        if (parent && parent.status === "in_review") await I.updateIssue(parent.id, { status: "todo", stage: "integrate" });
      }
    }
  } else {
    // lead-integrate
    await I.updateIssue(issue.id, { status: ok ? "done" : "in_review", summary: result.text }, { type: "agent", id: agent.id, runId: issue.runId });
  }
  tick(projectId);
}
