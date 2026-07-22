import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { getDatabase } from "@/lib/db/database";
import { ControlPlaneRepositories } from "@/lib/db/repositories";

export const runtime = "nodejs";

// Compact usage/budget totals for the active project, derived from the cost
// ledger — the same source Agent Detail and Run Detail read, so the Dashboard
// stays consistent with them.
export async function GET() {
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ usage: null });
  const repositories = new ControlPlaneRepositories(await getDatabase());
  return NextResponse.json({ usage: repositories.projectUsage(active.id) });
}
