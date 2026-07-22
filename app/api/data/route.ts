import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getDatabase } from "@/lib/db/database";
import { getActiveProject } from "@/lib/store";
import {
  applyRetention, deleteProjectData, DataControlError, exportProjectData, type RetentionPolicy,
} from "@/lib/governance";

export const runtime = "nodejs";

// Local user-data controls (NEXA-16): export a redacted copy of a project's
// data, delete eligible data with explicit confirmation and an outcome report,
// or apply the configured redacted log/event retention window.

// GET /api/data — export the active (or ?projectId=) project as a redacted bundle.
export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("projectId");
  const projectId = requested ?? (await getActiveProject())?.id ?? null;
  if (!projectId) return NextResponse.json({ error: "No project to export" }, { status: 404 });
  const bundle = exportProjectData(await getDatabase(), projectId);
  if (!bundle) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="nexotao-export-${projectId}.json"`,
    },
  });
}

// POST /api/data — { action: "delete" | "retention" }
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const database = await getDatabase();

  if (body.action === "delete") {
    const projectId = typeof body.projectId === "string" ? body.projectId : (await getActiveProject())?.id;
    if (!projectId) return NextResponse.json({ error: "No project to delete" }, { status: 404 });
    if (body.confirm !== true) return NextResponse.json({ error: "Deletion requires confirm: true" }, { status: 400 });
    try {
      const outcome = await deleteProjectData(database, projectId, { confirm: true });
      return NextResponse.json({ outcome });
    } catch (error) {
      if (error instanceof DataControlError) {
        return NextResponse.json({ error: error.message }, { status: error.code === "not_found" ? 404 : 400 });
      }
      throw error;
    }
  }

  if (body.action === "retention") {
    const config = await getConfig();
    const override = body.policy as RetentionPolicy | undefined;
    const policy: RetentionPolicy = override ?? config.retention ?? {};
    const outcome = await applyRetention(database, policy);
    return NextResponse.json({ outcome });
  }

  return NextResponse.json({ error: "Unsupported data action" }, { status: 400 });
}
