import { NextResponse } from "next/server";
import { getConfig, saveConfig, publicView, type Config } from "@/lib/config";
import { addProject, getActiveProject } from "@/lib/store";
import { seedAgents } from "@/lib/issues";

export const runtime = "nodejs";

export async function GET() {
  const c = await getConfig();
  return NextResponse.json({ ...publicView(c), project: await getActiveProject() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<Config> & { project?: { name: string; path: string; mode: "single" | "multi"; agents: any[] } };
  const patch: Partial<Config> = {};
  if (body.apiKey !== undefined) patch.apiKey = body.apiKey;
  if (body.model !== undefined) patch.model = body.model;
  if (body.onboarded !== undefined) patch.onboarded = body.onboarded;
  if (body.searchApiKey !== undefined) patch.searchApiKey = body.searchApiKey;
  if (body.telemetry !== undefined) patch.telemetry = body.telemetry === true;
  if (body.retention !== undefined && body.retention !== null) {
    const clampDays = (value: unknown): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const days = Number(value);
      return Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : null;
    };
    patch.retention = { runEventDays: clampDays(body.retention.runEventDays), auditDays: clampDays(body.retention.auditDays) };
  }

  if (body.project) {
    const p = await addProject(body.project);
    patch.activeProjectId = p.id;
    await seedAgents(p.id, p.agents ?? []); // create the lead + specialist workers
  }
  const c = await saveConfig(patch);
  return NextResponse.json({ ...publicView(c), project: await getActiveProject() });
}
