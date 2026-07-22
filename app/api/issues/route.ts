import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { createIssue, listIssues, listAgents, updateIssue, seedAgents, type IssueStatus } from "@/lib/issues";
import { submitGoal, tick, triggerHeartbeat } from "@/lib/executor";
import { IssueDomainError } from "@/lib/issue-lifecycle";

export const runtime = "nodejs";
export const maxDuration = 800;

/** The task/issue board + agent roster for the active project. */
export async function GET() {
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ issues: [], agents: [] });
  let agents = await listAgents(project.id);
  if (agents.length === 0) agents = await seedAgents(project.id, project.agents ?? []);
  const issues = await listIssues(project.id);
  return NextResponse.json({ issues, agents, projectId: project.id });
}

function domainErrorResponse(error: unknown) {
  if (!(error instanceof IssueDomainError)) throw error;
  const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

/** Submit a goal — creates the root issue for the lead and starts the run. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { goal?: unknown; mode?: unknown; title?: unknown; assigneeAgentId?: string | null; priority?: string } | null;
  if (body && typeof body.title === "string" && body.title.trim()) {
    const project = await getActiveProject();
    if (!project) return NextResponse.json({ error: "No active project." }, { status: 400 });
    try {
      const issue = await createIssue({
        projectId: project.id, title: body.title.trim(), assigneeAgentId: body.assigneeAgentId ?? null,
        priority: body.priority ?? "medium", status: "backlog", actor: { type: "user" },
        idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
      });
      return NextResponse.json({ issue }, { status: 201 });
    } catch (error) { return domainErrorResponse(error); }
  }
  if (!body || typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 20_000) return NextResponse.json({ error: "goal must be a non-empty string" }, { status: 400 });
  const goal = body.goal.trim();
  const mode = body.mode === "plan" || body.mode === "ask" ? body.mode : "agent";
  const cfg = await getConfig();
  if (!cfg.apiKey) return NextResponse.json({ error: "No Nexotao API key. Finish onboarding first." }, { status: 400 });
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ error: "No active project." }, { status: 400 });
  await seedAgents(project.id, project.agents ?? []);
  try {
    const root = await submitGoal(project.id, goal, mode, req.headers.get("idempotency-key") ?? undefined);
    return NextResponse.json({ root });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

/** Manual issue edits (e.g. moving a card on the board). */
export async function PATCH(req: Request) {
  const body = (await req.json()) as { id: string; status?: IssueStatus; stage?: "plan" | "execute" | "integrate"; title?: string; detail?: string; priority?: string; assigneeAgentId?: string | null; blockedBy?: string[] };
  const { id, status, ...patch } = body;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const project = await getActiveProject();
  try {
    const issue = await updateIssue(id, { ...patch, ...(status !== undefined ? { status } : {}) }, { type: "user" });
    if (!issue) return NextResponse.json({ error: "Issue not found", code: "not_found" }, { status: 404 });
    if (issue?.assigneeAgentId && status === "todo") {
      await triggerHeartbeat({ agentId: issue.assigneeAgentId, issueId: issue.id, reason: "invoke", eventId: `manual:${issue.updatedAt}` });
    } else if (project) await tick(project.id);
    return NextResponse.json({ issue });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
