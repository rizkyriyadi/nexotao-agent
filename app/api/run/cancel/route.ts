import { NextResponse } from "next/server";
import { getRun } from "@/lib/run-manager";
import { jsonError, readJsonObject, stringField } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const runId = stringField(body, "runId", { required: true, max: 100 })!;
    const run = getRun(runId);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    return NextResponse.json({ cancelled: run.cancel() });
  } catch (error) {
    return jsonError(error);
  }
}
