import { NextResponse } from "next/server";
import { listAgentRuns, addAgentRun, getActiveProject } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const agent = searchParams.get("agent") || undefined;
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ runs: [] });
  return NextResponse.json({ runs: await listAgentRuns(active.id, agent) });
}

export async function POST(req: Request) {
  const { agent, task, summary, ok } = (await req.json()) as { agent: string; task: string; summary: string; ok?: boolean };
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ error: "no active project" }, { status: 400 });
  return NextResponse.json({ run: await addAgentRun(active.id, { agent, task, summary, ok: ok ?? true }) });
}
