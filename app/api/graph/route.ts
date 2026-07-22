import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { readProjectGraph } from "@/lib/graph-data";
import { buildWorkGraph } from "@/lib/graphify";
import { detectGraphify, refreshCodeGraph } from "@/lib/graphify-code";
import { expandHome } from "@/lib/paths";

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
//  2. Code graph (Phase 5 / NEXA-32) — layered on top only when the optional
//     `graphify` CLI is on PATH. A clean no-op otherwise; `available` lets the UI
//     hint at the opt-in install without ever installing anything itself.
export async function POST() {
  const project = await getActiveProject();
  if (!project) {
    return NextResponse.json({ ok: false, error: "No active project." }, { status: 400 });
  }

  // 1. Work-history graph — always rebuilt from the full task history.
  const { graph } = await buildWorkGraph(project.id);

  // 2. Optional graphify code graph — layered on only when the CLI is present.
  const available = await detectGraphify();
  const root = expandHome(project.path || process.cwd());
  const codeNodes = available ? await refreshCodeGraph(project.id, root, { autoInstall: false }) : 0;

  return NextResponse.json({
    ok: true,
    project: { id: project.id, name: project.name },
    work: { nodes: graph.nodes.length, edges: graph.edges.length },
    code: { available, nodes: codeNodes },
    generatedAt: graph.generatedAt,
  });
}
