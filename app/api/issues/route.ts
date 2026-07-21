import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { listIssues, listAgents, updateIssue, seedAgents, type IssueStatus } from "@/lib/issues";
import { submitGoal, tick } from "@/lib/executor";

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

/** Submit a goal — creates the root issue for the lead and starts the run. */
export async function POST(req: Request) {
  const { goal } = (await req.json()) as { goal: string };
  const cfg = await getConfig();
  if (!cfg.apiKey) return NextResponse.json({ error: "No Nexotao API key. Finish onboarding first." }, { status: 400 });
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ error: "No active project." }, { status: 400 });
  await seedAgents(project.id, project.agents ?? []);
  const root = await submitGoal(project.id, goal);
  return NextResponse.json({ root });
}

/** Manual issue edits (e.g. moving a card on the board). */
export async function PATCH(req: Request) {
  const { id, status } = (await req.json()) as { id: string; status?: IssueStatus };
  const project = await getActiveProject();
  const issue = await updateIssue(id, status ? { status } : {});
  if (project) tick(project.id);
  return NextResponse.json({ issue });
}
