import { NextResponse } from "next/server";
import { resolveExecutionApproval } from "@/lib/execution-policy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { approvalId?: unknown; runId?: unknown; id?: unknown; decision?: unknown; note?: unknown } | null;
  if (!body || (body.decision !== "allow" && body.decision !== "deny") ||
      (typeof body.approvalId !== "string" && (typeof body.runId !== "string" || typeof body.id !== "string"))) {
    return NextResponse.json({ error: "invalid approval" }, { status: 400 });
  }
  const result = await resolveExecutionApproval({
    approvalId: typeof body.approvalId === "string" ? body.approvalId : undefined,
    runId: typeof body.runId === "string" ? body.runId : undefined,
    toolCallId: typeof body.id === "string" ? body.id : undefined,
    decision: body.decision,
    note: typeof body.note === "string" ? body.note : undefined,
  });
  if (result.state === "not_found") return NextResponse.json({ error: "approval not found" }, { status: 404 });
  if (result.state === "expired") return NextResponse.json({ error: "run is no longer waiting", approval: result.approval }, { status: 409 });
  return NextResponse.json({ ok: true, idempotent: result.state === "already_resolved", approval: result.approval });
}
