import { NextResponse } from "next/server";
import { getRun } from "@/lib/run-manager";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { runId, id, decision } = (await req.json()) as {
    runId: string;
    id: string;
    decision: "allow" | "deny";
  };
  const run = getRun(runId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  run.resolveApproval(id, decision === "allow" ? "allow" : "deny");
  return NextResponse.json({ ok: true });
}
