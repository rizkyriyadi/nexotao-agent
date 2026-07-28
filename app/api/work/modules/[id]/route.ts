import { NextResponse } from "next/server";
import { listIssues } from "@/lib/issues";
import { HttpError } from "@/lib/http";
import { getModule } from "@/lib/work-model";
import { progressOf } from "@/lib/work-analytics";
import { requireProject, workError } from "../../shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, context: Context) {
  try {
    const { id } = await context.params;
    const project = await requireProject();
    const record = await getModule(id);
    if (!record || record.projectId !== project.id) throw new HttpError("Module not found", 404);
    const issues = (await listIssues(project.id)).filter((issue) => issue.moduleIds.includes(id));
    return NextResponse.json({ module: record, issues, progress: progressOf(issues) });
  } catch (error) { return workError(error); }
}
