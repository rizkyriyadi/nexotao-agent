import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { installBlueprint, installRoleTemplate } from "@/lib/blueprints";
import { AgentLifecycleError } from "@/lib/agent-lifecycle";
import { HttpError, jsonError, readJsonObject, stringField } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

function lifecycleError(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status ?? 400 });
  if (!(error instanceof AgentLifecycleError)) return jsonError(error);
  const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

// One-click install. Body is either { blueprintId } to stand up a full team +
// wired starter issues, or { roleTemplateId, name? } to hire a single role.
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await getActiveProject();
    if (!project) throw new HttpError("No active project", 400);

    const blueprintId = stringField(body, "blueprintId", { max: 120 });
    if (blueprintId) {
      const result = await installBlueprint(project.id, blueprintId);
      return NextResponse.json({ result }, { status: 201 });
    }
    const roleTemplateId = stringField(body, "roleTemplateId", { max: 120 });
    if (roleTemplateId) {
      const name = stringField(body, "name", { max: 80 }) ?? undefined;
      const agent = await installRoleTemplate(project.id, roleTemplateId, { name });
      return NextResponse.json({ agent }, { status: 201 });
    }
    throw new HttpError("Provide blueprintId or roleTemplateId", 400);
  } catch (error) {
    return lifecycleError(error);
  }
}
