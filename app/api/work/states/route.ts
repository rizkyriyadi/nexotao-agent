import { NextResponse } from "next/server";
import { numberField, readJsonObject, stringField } from "@/lib/http";
import {
  createWorkflowState, deleteWorkflowState, ensureWorkflowStates, updateWorkflowState,
} from "@/lib/work-model";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

/* Board columns. The work model refuses a `statusGroup` outside the canonical
   seven and refuses to delete a column that still holds cards, so this file only
   parses; the rules live next to the data they protect. */

export async function GET() {
  try {
    const project = await requireProject();
    return NextResponse.json({ states: await ensureWorkflowStates(project.id) });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const state = await createWorkflowState({
      projectId: project.id,
      name: stringField(body, "name", { required: true, max: 80 })!,
      statusGroup: stringField(body, "statusGroup", { required: true, max: 20 })!,
      color: stringField(body, "color", { max: 20 }),
      position: numberField(body, "position", null) ?? undefined,
    });
    return NextResponse.json({ state }, { status: 201 });
  } catch (error) { return workError(error); }
}

export async function PATCH(req: Request) {
  try {
    const body = await readJsonObject(req);
    await requireProject();
    const state = await updateWorkflowState(stringField(body, "id", { required: true, max: 200 })!, {
      ...(body.name !== undefined ? { name: stringField(body, "name", { required: true, max: 80 })! } : {}),
      ...(body.statusGroup !== undefined ? { statusGroup: stringField(body, "statusGroup", { required: true, max: 20 })! } : {}),
      ...(body.color !== undefined ? { color: stringField(body, "color", { max: 20 })! } : {}),
      ...(body.position !== undefined ? { position: numberField(body, "position", null) ?? undefined } : {}),
    });
    return NextResponse.json({ state });
  } catch (error) { return workError(error); }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    await requireProject();
    await deleteWorkflowState(id);
    return NextResponse.json({ ok: true });
  } catch (error) { return workError(error); }
}
