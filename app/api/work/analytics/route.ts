import { NextResponse } from "next/server";
import { listIssues } from "@/lib/issues";
import { listCycles } from "@/lib/work-model";
import { burndown, progressOf, projectAnalytics } from "@/lib/work-analytics";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

/** Everything the analytics page charts. Throughput and cycle time come from the
 *  activity log's `issue.transitioned` events; the per-cycle burn-down comes from
 *  the daily snapshots `tick` records, because "how much was left on Tuesday"
 *  cannot be reconstructed from events alone. */
export async function GET(req: Request) {
  try {
    const project = await requireProject();
    const weeks = Number(new URL(req.url).searchParams.get("weeks"));
    const [analytics, cycles, issues] = await Promise.all([
      projectAnalytics(project.id, Number.isFinite(weeks) && weeks > 0 ? Math.min(weeks, 52) : 12),
      listCycles(project.id), listIssues(project.id),
    ]);
    const curves = await Promise.all(cycles.map(async (cycle) => ({
      cycle, progress: progressOf(issues.filter((issue) => issue.cycleId === cycle.id)), burndown: await burndown(cycle.id),
    })));
    return NextResponse.json({ analytics, cycles: curves });
  } catch (error) { return workError(error); }
}
