import { NextResponse } from "next/server";
import { listIssues } from "@/lib/issues";
import { numberField, readJsonObject, stringField } from "@/lib/http";
import { createModule, deleteModule, listModules, updateModule } from "@/lib/work-model";
import { progressOf } from "@/lib/work-analytics";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

export async function GET() {
  try {
    const project = await requireProject();
    const [modules, issues] = await Promise.all([listModules(project.id), listIssues(project.id)]);
    return NextResponse.json({
      modules: modules.map((module) => ({ ...module, progress: progressOf(issues.filter((issue) => issue.moduleIds.includes(module.id))) })),
    });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const record = await createModule({
      projectId: project.id,
      name: stringField(body, "name", { required: true, max: 120 })!,
      description: stringField(body, "description", { max: 10_000 }) ?? "",
      leadAgentId: stringField(body, "leadAgentId", { max: 100 }) ?? null,
      targetDate: numberField(body, "targetDate", null),
    });
    return NextResponse.json({ module: record }, { status: 201 });
  } catch (error) { return workError(error); }
}

export async function PATCH(req: Request) {
  try {
    const body = await readJsonObject(req);
    await requireProject();
    const record = await updateModule(stringField(body, "id", { required: true, max: 100 })!, {
      ...(body.name !== undefined ? { name: stringField(body, "name", { required: true, max: 120 })! } : {}),
      ...(body.description !== undefined ? { description: stringField(body, "description", { max: 10_000 }) ?? "" } : {}),
      ...(body.leadAgentId !== undefined ? { leadAgentId: body.leadAgentId === null ? null : stringField(body, "leadAgentId", { max: 100 })! } : {}),
      ...(body.targetDate !== undefined ? { targetDate: numberField(body, "targetDate", null) } : {}),
      ...(body.status !== undefined ? { status: stringField(body, "status", { max: 20 })! } : {}),
      ...(body.completedAt !== undefined ? { completedAt: numberField(body, "completedAt", null) } : {}),
    });
    return NextResponse.json({ module: record });
  } catch (error) { return workError(error); }
}

export async function DELETE(req: Request) {
  try {
    await requireProject();
    await deleteModule(new URL(req.url).searchParams.get("id") ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) { return workError(error); }
}
