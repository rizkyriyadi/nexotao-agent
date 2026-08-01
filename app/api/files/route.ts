import { NextResponse } from "next/server";
import { activeRoot, readTree } from "@/lib/workspace-files";

export const runtime = "nodejs";

/** The workspace tree.
 *
 *  One folder, always: the project the user has open, which is also the folder
 *  runs write into. There is nothing to choose between any more.
 *
 *  Returns the whole visible tree in one response so the panel can search across
 *  every path rather than only the folders that happen to be expanded. */
export async function GET() {
  try {
    const root = await activeRoot();
    if (!root) return NextResponse.json({ root: null, tree: [], truncated: false });
    const { tree, truncated } = await readTree(root.path);
    return NextResponse.json({ root, tree, truncated });
  } catch (error) {
    return NextResponse.json({ root: null, tree: [], truncated: false, error: String(error) }, { status: 500 });
  }
}
