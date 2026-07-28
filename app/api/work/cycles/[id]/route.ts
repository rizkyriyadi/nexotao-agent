import { NextResponse } from "next/server";
import { listIssues } from "@/lib/issues";
import { HttpError } from "@/lib/http";
import { getCycle } from "@/lib/work-model";
import { burndown, progressOf } from "@/lib/work-analytics";
import { requireProject, workError } from "../../shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** One cycle with everything its detail page draws: its work items, the progress
 *  bar, and the burn-down curve recorded by `tick`. */
export async function GET(_req: Request, context: Context) {
  try {
    const { id } = await context.params;
    const project = await requireProject();
    const cycle = await getCycle(id);
    if (!cycle || cycle.projectId !== project.id) throw new HttpError("Cycle not found", 404);
    const issues = (await listIssues(project.id)).filter((issue) => issue.cycleId === id);
    return NextResponse.json({ cycle, issues, progress: progressOf(issues), burndown: await burndown(id) });
  } catch (error) { return workError(error); }
}
