import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { readProjectGraph } from "@/lib/graph-data";
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

// On-demand rebuild of the optional graphify code graph (Phase 5 / NEXA-32).
// Explicit user action only — never runs on the hot path. A clean no-op when the
// `graphify` CLI is not installed: reports availability so the UI can hint at the
// opt-in `pip install` without ever installing anything itself.
export async function POST() {
  const project = await getActiveProject();
  if (!project) {
    return NextResponse.json({ ok: false, available: false, error: "No active project." }, { status: 400 });
  }
  const available = await detectGraphify();
  if (!available) {
    return NextResponse.json({ ok: true, available: false, nodes: 0, message: "graphify CLI not found; code graph skipped." });
  }
  const root = expandHome(project.path || process.cwd());
  const nodes = await refreshCodeGraph(project.id, root, { autoInstall: false });
  return NextResponse.json({ ok: true, available: true, nodes });
}
