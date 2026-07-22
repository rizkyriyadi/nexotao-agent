import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { readProjectGraph } from "@/lib/graph-data";

export const runtime = "nodejs";

// Serves the active project's knowledge graph (work history + optional code
// graph) for the /graph page. Read-only; degrades to an empty graph when
// nothing has been indexed yet.
export async function GET() {
  const project = await getActiveProject();
  if (!project) {
    return NextResponse.json({ project: null, projectId: null, empty: true, nodes: [], edges: [], generatedAt: null });
  }
  const graph = await readProjectGraph(project.id);
  return NextResponse.json({
    project: { id: project.id, name: project.name },
    projectId: project.id,
    empty: graph.nodes.length === 0,
    nodes: graph.nodes,
    edges: graph.edges,
    generatedAt: graph.generatedAt ?? null,
  });
}
