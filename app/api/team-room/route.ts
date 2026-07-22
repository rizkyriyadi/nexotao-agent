import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { listAgents, listIssues, seedAgents } from "@/lib/issues";
import { buildTeamRoom } from "@/lib/team-room";

export const runtime = "nodejs";

// Live snapshot for the Team Room. Reads the current board (issues + agents)
// and derives who is active, the hand-offs between agents, and where work is
// blocked. Read-only and cheap — the client polls it to stay live. Degrades to
// an empty room when there is no active project yet.
export async function GET() {
  const project = await getActiveProject();
  if (!project) {
    return NextResponse.json({
      project: null,
      empty: true,
      room: buildTeamRoom([], [], Date.now()),
    });
  }
  let agents = await listAgents(project.id);
  if (agents.length === 0) agents = await seedAgents(project.id, project.agents ?? []);
  const issues = await listIssues(project.id);
  const room = buildTeamRoom(issues, agents, Date.now());
  return NextResponse.json({
    project: { id: project.id, name: project.name },
    empty: room.agents.length === 0,
    room,
  });
}
