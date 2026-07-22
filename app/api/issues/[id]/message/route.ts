import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db/database";
import { ControlPlaneRepositories } from "@/lib/db/repositories";
import { getIssue, reopenIssue, type RunMode } from "@/lib/issues";
import { tick } from "@/lib/executor";
import { IssueDomainError } from "@/lib/issue-lifecycle";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Send a follow-up message to the agent on an existing task. The message is
 * recorded on the thread and the task is reopened (a finished task goes back to
 * in-progress on the same issue). If a run is already executing, the follow-up
 * is queued behind it. This is how a task turns into an ongoing conversation.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const issue = await getIssue(id);
  if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

  const body = await request.json().catch(() => null) as { body?: unknown; mode?: unknown } | null;
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return NextResponse.json({ error: "Message body is required" }, { status: 400 });
  const mode: RunMode | undefined = body?.mode === "agent" || body?.mode === "plan" || body?.mode === "ask" ? body.mode : undefined;

  const database = await getDatabase();
  const repositories = new ControlPlaneRepositories(database);

  try {
    const comment = await repositories.addComment({ issueId: id, authorType: "user", body: text });
    // Reopen the task (a finished one goes back to todo) and let tick wake the
    // lead. A task that's still running keeps its run; the executor re-queues it
    // afterwards because this new comment is newer than that run's start.
    const reopened = await reopenIssue(id, { type: "user" }, mode);
    if (!reopened) return NextResponse.json({ error: "Issue not found" }, { status: 404 });
    await tick(reopened.projectId);
    return NextResponse.json({ comment, issue: reopened }, { status: 201 });
  } catch (error) {
    if (error instanceof IssueDomainError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }
}
