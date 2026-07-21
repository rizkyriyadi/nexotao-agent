import { NextResponse } from "next/server";
import { getConfig, saveConfig, publicView, type Config } from "@/lib/config";
import { addProject, getActiveProject } from "@/lib/store";

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

  if (body.project) {
    const p = await addProject(body.project);
    patch.activeProjectId = p.id;
  }
  const c = await saveConfig(patch);
  return NextResponse.json({ ...publicView(c), project: await getActiveProject() });
}
