import { NextResponse } from "next/server";
import { listTasks, addTask, updateTask, getActiveProject } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const active = await getActiveProject();
  return NextResponse.json({ tasks: active ? await listTasks(active.id) : [] });
}

export async function POST(req: Request) {
  const { title } = (await req.json()) as { title: string };
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ error: "no active project" }, { status: 400 });
  return NextResponse.json({ task: await addTask(active.id, title) });
}

export async function PATCH(req: Request) {
  const { id, ...patch } = (await req.json()) as { id: string; col?: string; title?: string };
  return NextResponse.json({ task: await updateTask(id, patch as any) });
}
