import { NextResponse } from "next/server";
import { getConfig, saveConfig, publicView, type Config } from "@/lib/config";
import { addProject, getActiveProject } from "@/lib/store";
import { seedAgents } from "@/lib/issues";
import { AGENT_MODES, type AgentMode } from "@/lib/execution-policy";
import { refreshCodeIndex } from "@/lib/code-memory";

export const runtime = "nodejs";

export async function GET() {
  const c = await getConfig();
  return NextResponse.json({ ...publicView(c), project: await getActiveProject() });
}

export async function POST(req: Request) {
  let body: Partial<Config> & { project?: { name: string; path: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const patch: Partial<Config> = {};
  if (body.apiKey !== undefined) patch.apiKey = body.apiKey;
  if (body.model !== undefined) patch.model = body.model;
  if (body.onboarded !== undefined) patch.onboarded = body.onboarded;
  if (body.defaultMode !== undefined && AGENT_MODES.includes(body.defaultMode as AgentMode)) patch.defaultMode = body.defaultMode as AgentMode;
  if (body.reviewMode === "review" || body.reviewMode === "auto") patch.reviewMode = body.reviewMode;
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
    const name = body.project.name?.trim();
    const path = body.project.path?.trim();
    if (!name || !path) return NextResponse.json({ error: "A project needs both a name and a folder." }, { status: 400 });
    try {
      const p = await addProject({ name, path });
      patch.activeProjectId = p.id;
      await seedAgents(p.id); // every project needs its agent before it can run
      // Fire-and-forget beside seedAgents: a cold index can take minutes, and
      // onboarding must not sit on a spinner waiting for one.
      void refreshCodeIndex(p.id, p.path, { mode: "moderate" }).catch(() => null);
    } catch (error) {
      // Onboarding reads this message verbatim. Returning it — rather than
      // letting the throw become an opaque 500 — is what turns a silent bounce
      // back to step one into something the user can act on.
      return NextResponse.json({ error: `Couldn't open that folder as a project: ${(error as Error).message}` }, { status: 500 });
    }
  }
  try {
    const c = await saveConfig(patch);
    return NextResponse.json({ ...publicView(c), project: await getActiveProject() });
  } catch (error) {
    return NextResponse.json({ error: `Couldn't write your settings: ${(error as Error).message}` }, { status: 500 });
  }
}
