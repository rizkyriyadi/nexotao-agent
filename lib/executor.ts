// The control plane. Turns a goal into a root issue for the lead, then drives
// the whole delegation lifecycle: the lead plans + delegates (creating child
// issues), the executor wakes each assignee whose dependencies are met and runs
// it in parallel, and when all children finish it wakes the lead to integrate.
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { getConfig } from "./config";
import { getProject, addAgentRun } from "./store";
import { expandHome } from "./paths";
import { DEFAULT_MODEL } from "./nexotao";
import { createRun, getRun } from "./run-manager";
import { runIssueAgent } from "./agent";
import * as I from "./issues";

const running = new Set<string>(); // issue ids currently executing (dedupe)

async function ctx(projectId: string) {
  const cfg = await getConfig();
  const project = await getProject(projectId);
  const root = expandHome(project?.path || process.cwd());
  await fs.mkdir(root, { recursive: true }).catch(() => {});
  return { apiKey: cfg.apiKey || "", model: cfg.model || DEFAULT_MODEL, root };
}

/** Create the root issue for a goal and start the run. */
export async function submitGoal(projectId: string, text: string): Promise<I.Issue> {
  let lead = await I.leadAgent(projectId);
  if (!lead) {
    const project = await getProject(projectId);
    const seeded = await I.seedAgents(projectId, project?.agents ?? []);
    lead = seeded.find((a) => a.role === "lead") ?? null;
  }
  const root = await I.createIssue({
    projectId, title: text, detail: text,
    assigneeAgentId: lead?.id ?? null, createdByAgentId: null,
    status: lead ? "todo" : "backlog", stage: "plan",
  });
  tick(projectId);
  return root;
}

/** Evaluate all issues and start any that are ready (assigned, unblocked, idle). */
export async function tick(projectId: string) {
  const issues = await I.listIssues(projectId);
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const it of issues) {
    if (!it.assigneeAgentId) continue;
    // recover an issue orphaned by a server restart (its live run is gone) → re-queue
    if (it.status === "in_progress" && !running.has(it.id) && (!it.runId || !getRun(it.runId))) {
      await I.updateIssue(it.id, { status: "todo", runId: null }).catch(() => {});
    }
    if (it.status !== "todo" && it.status !== "blocked") continue;
    if (running.has(it.id)) continue;
    const unmet = it.blockedBy.filter((bid) => byId.get(bid)?.status !== "done");
    if (unmet.length) {
      if (it.status !== "blocked") I.updateIssue(it.id, { status: "blocked" }).catch(() => {});
      continue;
    }
    if (it.status === "blocked") await I.updateIssue(it.id, { status: "todo" }).catch(() => {});
    startIssue(projectId, it.id); // fire and forget
  }
}

async function startIssue(projectId: string, issueId: string) {
  if (running.has(issueId)) return;
  running.add(issueId);
  try {
    const runId = randomUUID();
    const issue = await I.claimIssue(issueId, runId); // atomic in_progress + lock
    if (!issue) return;
    const agent = issue.assigneeAgentId ? await I.getAgent(issue.assigneeAgentId) : null;
    if (!agent) { await I.updateIssue(issueId, { status: "todo" }); return; }

    const { apiKey, model, root } = await ctx(projectId);
    const run = createRun(runId, undefined, { kind: "orchestrator", title: issue.title, projectId });
    run.push({ type: "run", runId });
    run.push({ type: "status", status: "running" });

    const isLead = agent.role === "lead";
    const mode = isLead ? (issue.stage === "integrate" ? "lead-integrate" : "lead-plan") : "worker";

    // context the lead needs
    const workers = (await I.listAgents(projectId)).filter((a) => a.role === "worker").map((a) => ({ name: a.name, scope: a.scope }));
    let childrenReport = "";
    if (mode === "lead-integrate") {
      const kids = await I.childrenOf(issue.id);
      childrenReport = kids.map((k) => `- ${k.title} (${k.assigneeAgentId ? "" : ""}): ${k.summary || "done"}`).join("\n");
    }

    const onDelegate = async (tasks: any[]) => {
      const created: { assignee: string; title: string; id: string }[] = [];
      const nameToId: Record<string, string> = {};
      for (const t of tasks) {
        const worker = (await I.findAgentByName(projectId, String(t.assignee || ""))) ?? agent;
        const child = await I.createIssue({
          projectId, title: String(t.title || t.assignee || "Task"), detail: String(t.detail || t.title || ""),
          parentId: issue.id, assigneeAgentId: worker.id, createdByAgentId: agent.id, status: "todo", stage: "execute",
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
        run, apiKey, model, root, mode,
        agentName: agent.name, agentScope: agent.scope,
        goal: issue.title, detail: issue.detail, workers, childrenReport, onDelegate,
      });
      run.push({ type: "done" });
    } catch (e: any) {
      run.push({ type: "error", error: String(e?.message ?? e) });
      result = { text: `Failed: ${String(e?.message ?? e)}`, delegated: false };
      if (run.cancelled) await I.updateIssue(issueId, { status: "cancelled", summary: "Cancelled by user" });
      else await onIssueFinished(projectId, issue, agent, mode, result, false);
      return;
    }
    await onIssueFinished(projectId, issue, agent, mode, result, true);
  } finally {
    running.delete(issueId);
  }
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
      await I.updateIssue(issue.id, { status: "in_review", stage: "integrate", summary: result.text });
    } else {
      await I.updateIssue(issue.id, { status: ok ? "done" : "in_review", summary: result.text });
    }
  } else if (mode === "worker") {
    await I.updateIssue(issue.id, { status: ok ? "done" : "in_review", summary: result.text });
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
    await I.updateIssue(issue.id, { status: ok ? "done" : "in_review", summary: result.text });
  }
  tick(projectId);
}
