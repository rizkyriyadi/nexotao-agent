import { NextResponse } from "next/server";
import { listRunRecords } from "@/lib/store";
import { getActiveProject } from "@/lib/store";

export const runtime = "nodejs";

/** All runs for the active project (running + finished), newest first. */
export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind"); // optional filter
  const project = await getActiveProject();
  let rows = await listRunRecords(project?.id);
  if (kind) rows = rows.filter((r) => r.kind === kind);
  const runs = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  return NextResponse.json({ runs });
}
