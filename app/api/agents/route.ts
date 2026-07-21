import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { listAgents, listIssues, seedAgents } from "@/lib/issues";

export const runtime = "nodejs";

/** Persistent agent roster + each agent's issues (their work history). */
export async function GET() {
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ agents: [], issues: [] });
  let agents = await listAgents(project.id);
  if (agents.length === 0) agents = await seedAgents(project.id, project.agents ?? []);
  const issues = await listIssues(project.id);
  return NextResponse.json({ agents, issues });
}
