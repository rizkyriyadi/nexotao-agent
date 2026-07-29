import { NextResponse } from "next/server";
import { resolveRoot, writeFile } from "@/lib/workspace-files";

export const runtime = "nodejs";

/** Save an edited text file.
 *
 *  A conflict — the file moved on disk since it was opened, or it was too large
 *  to have been read whole — answers 409 rather than 400. It is not a malformed
 *  request; it is a request that was correct when it was composed and has since
 *  been overtaken, which is the one case the editor needs to tell apart so it
 *  can offer to reload. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as
    | { root?: unknown; path?: unknown; text?: unknown; version?: { size?: unknown; mtimeMs?: unknown } | null }
    | null;

  const file = typeof body?.path === "string" ? body.path : "";
  const text = typeof body?.text === "string" ? body.text : null;
  if (!file || text === null) return NextResponse.json({ error: "Missing path or text" }, { status: 400 });

  const root = await resolveRoot(typeof body?.root === "string" ? body.root : null);
  if (!root) return NextResponse.json({ error: "No project is open" }, { status: 404 });

  const version =
    typeof body?.version?.size === "number" && typeof body?.version?.mtimeMs === "number"
      ? { size: body.version.size, mtimeMs: body.version.mtimeMs }
      : null;

  try {
    const result = await writeFile(root.path, file, text, version);
    if (!result.ok) return NextResponse.json({ error: result.conflict }, { status: 409 });
    return NextResponse.json({ ok: true, version: result.version });
  } catch (error) {
    return NextResponse.json({ error: String(error instanceof Error ? error.message : error) }, { status: 400 });
  }
}
