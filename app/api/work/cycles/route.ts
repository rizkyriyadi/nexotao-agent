import { NextResponse } from "next/server";
import { listIssues } from "@/lib/issues";
import { numberField, readJsonObject, stringField } from "@/lib/http";
import { createCycle, deleteCycle, listCycles, updateCycle } from "@/lib/work-model";
import { progressOf } from "@/lib/work-analytics";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

/** Cycles with their progress attached, so the list can render a bar per row
 *  without a request per cycle. */
export async function GET() {
  try {
    const project = await requireProject();
    const [cycles, issues] = await Promise.all([listCycles(project.id), listIssues(project.id)]);
    return NextResponse.json({
      cycles: cycles.map((cycle) => ({ ...cycle, progress: progressOf(issues.filter((issue) => issue.cycleId === cycle.id)) })),
    });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const cycle = await createCycle({
      projectId: project.id,
      name: stringField(body, "name", { required: true, max: 120 })!,
      description: stringField(body, "description", { max: 10_000 }) ?? "",
      startDate: numberField(body, "startDate", null),
      endDate: numberField(body, "endDate", null),
    });
    return NextResponse.json({ cycle }, { status: 201 });
  } catch (error) { return workError(error); }
}

export async function PATCH(req: Request) {
  try {
    const body = await readJsonObject(req);
    await requireProject();
    const cycle = await updateCycle(stringField(body, "id", { required: true, max: 100 })!, {
      ...(body.name !== undefined ? { name: stringField(body, "name", { required: true, max: 120 })! } : {}),
      ...(body.description !== undefined ? { description: stringField(body, "description", { max: 10_000 }) ?? "" } : {}),
      ...(body.startDate !== undefined ? { startDate: numberField(body, "startDate", null) } : {}),
      ...(body.endDate !== undefined ? { endDate: numberField(body, "endDate", null) } : {}),
      ...(body.completedAt !== undefined ? { completedAt: numberField(body, "completedAt", null) } : {}),
    });
    return NextResponse.json({ cycle });
  } catch (error) { return workError(error); }
}

/* Deleting a cycle detaches its work items rather than deleting them — a sprint
   ending is not a reason to lose the work that did not fit in it. */
export async function DELETE(req: Request) {
  try {
    await requireProject();
    await deleteCycle(new URL(req.url).searchParams.get("id") ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) { return workError(error); }
}
