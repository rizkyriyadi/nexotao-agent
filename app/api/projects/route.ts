import { NextResponse } from "next/server";
import { getConfig, saveConfig } from "@/lib/config";
import { listProjects, addProject, listSessions, listTasks } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const [projects, cfg, sessions, tasks] = await Promise.all([listProjects(), getConfig(), listSessions(), listTasks()]);
  const withCounts = projects.map((p) => ({
    ...p,
    sessions: sessions.filter((s) => s.projectId === p.id).length,
    tasks: tasks.filter((t) => t.projectId === p.id).length,
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
