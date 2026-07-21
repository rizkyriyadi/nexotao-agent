import { NextResponse } from "next/server";
import { listSessions, getSession, createSession, saveSessionMessages, getActiveProject } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (id) return NextResponse.json({ session: await getSession(id) });
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ sessions: [] });
  const sessions = (await listSessions(active.id)).map(({ messages, ...s }) => ({ ...s, count: messages.length }));
  return NextResponse.json({ sessions });
}

export async function POST(req: Request) {
  const { title } = (await req.json().catch(() => ({}))) as { title?: string };
  const active = await getActiveProject();
  if (!active) return NextResponse.json({ error: "no active project" }, { status: 400 });
  return NextResponse.json({ session: await createSession(active.id, title ?? "New session") });
}

export async function PATCH(req: Request) {
  const { id, messages, title } = (await req.json()) as { id: string; messages: any[]; title?: string };
  return NextResponse.json({ session: await saveSessionMessages(id, messages, title) });
}
