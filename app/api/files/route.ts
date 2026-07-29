import { NextResponse } from "next/server";
import { activeRoot, pendingWork, readTree } from "@/lib/workspace-files";

export const runtime = "nodejs";

/** The workspace tree, as one folder.
 *
 *  The folder is chosen here rather than offered as a list to pick from: there
 *  is one project, and a run's worktree is a temporary place the agent writes.
 *  Asking the user which of the two they meant made the panel look like it kept
 *  a different folder per task. `activeRoot` follows the work instead.
 *
 *  Returns the whole visible tree in one response so the panel can search across
 *  every path rather than only the folders that happen to be expanded. */
export async function GET() {
  try {
    const root = await activeRoot();
    if (!root) return NextResponse.json({ root: null, tree: [], truncated: false, notice: null });
    const [{ tree, truncated }, notice] = await Promise.all([
      readTree(root.path),
      // Only meaningful over the project folder: during a run the panel is
      // showing the worktree, where the files are in plain sight.
      root.kind === "project" ? pendingWork() : Promise.resolve(null),
    ]);
    return NextResponse.json({ root, tree, truncated, notice });
  } catch (error) {
    return NextResponse.json({ root: null, tree: [], truncated: false, notice: null, error: String(error) }, { status: 500 });
  }
}
