import { NextResponse } from "next/server";
import { getActiveRun } from "@/lib/run-manager";

export const runtime = "nodejs";

/** Is there an in-flight run for this session? Used on boot to decide whether
 * to reconnect to the live stream or just show the saved messages. */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session");
  const run = sessionId ? getActiveRun(sessionId) : undefined;
  return NextResponse.json({ running: !!run && !run.finished, runId: run?.id ?? null });
}
