import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { expandHome } from "@/lib/paths";
import { listTree } from "@/lib/tools";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sub = searchParams.get("path") || ".";
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ entries: [] });
  const root = expandHome(project.path);
  try {
    return NextResponse.json({ entries: await listTree(root, sub), path: sub });
  } catch (e) {
    return NextResponse.json({ entries: [], error: String(e) });
  }
}
