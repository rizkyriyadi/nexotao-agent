import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db/database";
import { ControlPlaneRepositories } from "@/lib/db/repositories";
import { parseRunEventCursor, RunEventDomainError, type DurableRunEvent } from "@/lib/run-events";

export const runtime = "nodejs";

function responseEvents(events: DurableRunEvent[]) {
  return events.map((event) => ({
    runId: event.runId, seq: event.seq, type: event.type,
    payload: event.redactedPayload, createdAt: event.createdAt,
  }));
}

/** Query durable events at run, issue, or project scope. Run queries support a
 * sequence cursor; wider scopes return the newest bounded event window. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const runId = url.searchParams.get("runId");
    const issueId = url.searchParams.get("issueId");
    const projectId = url.searchParams.get("projectId");
    if ([runId, issueId, projectId].filter(Boolean).length !== 1) {
      return NextResponse.json({ error: "Provide exactly one of runId, issueId, or projectId" }, { status: 400 });
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? 200);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
    const limit = Math.min(rawLimit, 500);
    const repositories = new ControlPlaneRepositories(await getDatabase());
    let events: DurableRunEvent[];
    if (runId) {
      if (!repositories.getHeartbeat(runId)) return NextResponse.json({ error: "Run not found" }, { status: 404 });
      events = repositories.listRunEvents(runId, parseRunEventCursor(url.searchParams.get("cursor")), limit);
    } else if (issueId) events = repositories.listIssueRunEvents(issueId, limit);
    else events = repositories.listProjectRunEvents(projectId!, limit);
    const serialized = responseEvents(events);
    return NextResponse.json({ events: serialized, nextCursor: runId ? (serialized.at(-1)?.seq ?? parseRunEventCursor(url.searchParams.get("cursor"))) : null });
  } catch (error) {
    if (error instanceof RunEventDomainError) return NextResponse.json({ error: error.message }, { status: error.code === "not_found" ? 404 : 400 });
    throw error;
  }
}
