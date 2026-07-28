import { NextResponse } from "next/server";
import { getConfig, saveConfig } from "@/lib/config";
import { listProjects, addProject, listSessions, listIssues } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  // Counted from `issues`, not the legacy `tasks` table: nothing has written a
  // `tasks` row since work moved to issues, so the card read "0 tasks" for every
  // project that had plenty.
  const [projects, cfg, sessions, work] = await Promise.all([listProjects(), getConfig(), listSessions(), listIssues()]);
  const withCounts = projects.map((p) => ({
    ...p,
    sessions: sessions.filter((s) => s.projectId === p.id).length,
    tasks: work.filter((issue) => issue.projectId === p.id).length,
  }));
  return NextResponse.json({ projects: withCounts, activeId: cfg.activeProjectId ?? null });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; path: string; mode?: "single" | "multi"; agents?: any[] };
  const p = await addProject({ name: body.name, path: body.path, mode: body.mode ?? "single", agents: body.agents ?? [] });
  await saveConfig({ activeProjectId: p.id });
  return NextResponse.json({ project: p });
}

export async function PATCH(req: Request) {
  const { id } = (await req.json()) as { id: string };
  await saveConfig({ activeProjectId: id });
  return NextResponse.json({ ok: true });
}
