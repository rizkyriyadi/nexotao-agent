import { NextResponse } from "next/server";
import { readJsonObject, stringField } from "@/lib/http";
import { createLabel, deleteLabel, listLabels, updateLabel } from "@/lib/work-model";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

export async function GET() {
  try {
    const project = await requireProject();
    return NextResponse.json({ labels: await listLabels(project.id) });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const label = await createLabel({
      projectId: project.id,
      name: stringField(body, "name", { required: true, max: 60 })!,
      color: stringField(body, "color", { max: 20 }),
    });
    return NextResponse.json({ label }, { status: 201 });
  } catch (error) { return workError(error); }
}

export async function PATCH(req: Request) {
  try {
    const body = await readJsonObject(req);
    await requireProject();
    const label = await updateLabel(stringField(body, "id", { required: true, max: 100 })!, {
      ...(body.name !== undefined ? { name: stringField(body, "name", { required: true, max: 60 })! } : {}),
      ...(body.color !== undefined ? { color: stringField(body, "color", { max: 20 })! } : {}),
    });
    return NextResponse.json({ label });
  } catch (error) { return workError(error); }
}

/* Deleting a label detaches it from its work items through the cascade on
   `issue_labels` — a label is a tag, not a container, so nothing is orphaned. */
export async function DELETE(req: Request) {
  try {
    await requireProject();
    await deleteLabel(new URL(req.url).searchParams.get("id") ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) { return workError(error); }
}
