import { NextResponse } from "next/server";
import { readPreview, resolveRoot } from "@/lib/workspace-files";

export const runtime = "nodejs";

/** One file, rendered for reading: markdown and code as text, PDFs extracted,
 *  images inlined, anything else declared binary rather than shown as mojibake. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const file = searchParams.get("path");
  if (!file) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  const root = await resolveRoot(searchParams.get("root"));
  if (!root) return NextResponse.json({ error: "No project is open" }, { status: 404 });
  try {
    return NextResponse.json(await readPreview(root.path, file));
  } catch (error) {
    // Path traversal and a missing file both land here. The message is the
    // thrown one either way — it is the user's own machine, so naming the
    // reason is more useful than a generic failure.
    return NextResponse.json({ error: String(error instanceof Error ? error.message : error) }, { status: 400 });
  }
}
