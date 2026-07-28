import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { readProjectGraph } from "@/lib/graph-data";
import { buildWorkGraph } from "@/lib/graphify";
import { detectCodeMemory, indexProject } from "@/lib/code-memory";

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

// On-demand "build knowledge graph" for the active project (the graph-menu
// action). Explicit user action only — never runs on the hot path.
//
// Two layers, each independent:
//  1. Work-history graph — a full rebuild from the entire task history
//     (buildWorkGraph). Always available, no external dependency. This is the
//     "build knowledge first" step: every existing issue, run, agent, session
//     and memory link is indexed up front instead of only accruing as new runs
//     finish.
//  2. Code index — symbols and call graph from the optional
//     `codebase-memory-mcp` CLI. A clean no-op when it is not installed;
//     `available` is what lets the UI offer the install without this route ever
//     installing anything itself.
export async function POST() {
  const project = await getActiveProject();
  if (!project) {
    return NextResponse.json({ ok: false, error: "No active project." }, { status: 400 });
  }

  // 1. Work-history graph — always rebuilt from the full task history.
  const { graph } = await buildWorkGraph(project.id);

  // 2. Optional code index. Awaited, unlike every other refresh trigger: this
  //    one is an explicit button press with a spinner behind it, so returning
  //    before the count exists would report zero symbols for a healthy index.
  const available = await detectCodeMemory();
  const status = available ? await indexProject(project.id, project.path, { mode: "moderate" }) : null;

  return NextResponse.json({
    ok: true,
    project: { id: project.id, name: project.name },
    work: { nodes: graph.nodes.length, edges: graph.edges.length },
    code: {
      available,
      project: status?.project ?? null,
      nodes: status?.nodes ?? 0,
      edges: status?.edges ?? 0,
      indexedAt: status?.indexedAt ?? null,
    },
    generatedAt: graph.generatedAt,
  });
}
