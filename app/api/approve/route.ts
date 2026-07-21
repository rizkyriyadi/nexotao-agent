import { NextResponse } from "next/server";
import { getRun } from "@/lib/run-manager";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { runId?: unknown; id?: unknown; decision?: unknown } | null;
  if (!body || typeof body.runId !== "string" || typeof body.id !== "string" || (body.decision !== "allow" && body.decision !== "deny")) return NextResponse.json({ error: "invalid approval" }, { status: 400 });
  const { runId, id, decision } = body as { runId: string; id: string; decision: "allow" | "deny" };
  const run = getRun(runId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  run.resolveApproval(id, decision === "allow" ? "allow" : "deny");
  return NextResponse.json({ ok: true });
}
