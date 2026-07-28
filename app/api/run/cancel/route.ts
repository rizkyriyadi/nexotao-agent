import { NextResponse } from "next/server";
import { getRun } from "@/lib/run-manager";
import { cancelHeartbeat } from "@/lib/executor";
import { jsonError, readJsonObject, stringField } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const runId = stringField(body, "runId", { required: true, max: 100 })!;
    const run = getRun(runId);
    const liveCancelled = run?.cancel() ?? false;
    // The heartbeat runtime owns the durable half (terminal run event + issue
    // release) and is idempotent, so cancelling twice still reports success
    // instead of stranding the UI on a 404. A run with no heartbeat row at all
    // is a plain chat run, cancellable only in memory.
    const cancelled = (await cancelHeartbeat(runId)) || liveCancelled;
    return cancelled
      ? NextResponse.json({ cancelled: true })
      : NextResponse.json({ error: "Run not found" }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}
