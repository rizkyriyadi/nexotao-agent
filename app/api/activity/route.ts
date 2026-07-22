import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db/database";
import { ControlPlaneRepositories } from "@/lib/db/repositories";
import { getActiveProject } from "@/lib/store";

export const runtime = "nodejs";

// Project-scoped append-only activity feed for sensitive mutations (assignment,
// checkout, status, approval, budget, permission, agent-config). Summaries are
// redacted at write time; this endpoint only reads them back.
export async function GET(request: Request) {
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ activity: [] });
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 200, 1), 1000);
  const repositories = new ControlPlaneRepositories(await getDatabase());
  return NextResponse.json({ projectId: active.id, activity: repositories.listProjectActivity(active.id, limit) });
}
