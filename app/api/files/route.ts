import { NextResponse } from "next/server";
import { listRoots, readTree, resolveRoot } from "@/lib/workspace-files";

export const runtime = "nodejs";

/** The workspace tree for one root (the project folder, or a run's working copy).
 *  Returns the whole visible tree in one response so the panel can search across
 *  every path rather than only the folders that happen to be expanded. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  try {
    const roots = await listRoots();
    if (!roots.length) return NextResponse.json({ roots: [], root: null, tree: [], truncated: false });
    const root = (await resolveRoot(searchParams.get("root"))) ?? roots[0];
    const { tree, truncated } = await readTree(root.path);
    return NextResponse.json({ roots, root, tree, truncated });
  } catch (error) {
    return NextResponse.json({ roots: [], root: null, tree: [], truncated: false, error: String(error) }, { status: 500 });
  }
}
