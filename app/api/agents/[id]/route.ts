import { NextResponse } from "next/server";
import { AgentLifecycleError, AgentLifecycleService } from "@/lib/agent-lifecycle";
import { getDatabase } from "@/lib/db/database";
import { cancelHeartbeat, retryHeartbeat, triggerHeartbeat } from "@/lib/executor";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

function lifecycleError(error: unknown) {
  if (!(error instanceof AgentLifecycleError)) return jsonError(error);
  const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "confirmation_required" ? 428 : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

// Hard-delete an agent (distinct from the reversible `terminate` action, which
// only flips status). Confirmation is required and is passed as `?confirmed=1`
// so the removal cannot happen on an accidental request.
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const confirmed = new URL(req.url).searchParams.get("confirmed") === "1";
    const service = new AgentLifecycleService(await getDatabase(), {
      invoke: (input) => triggerHeartbeat({ ...input, reason: "invoke" }),
      cancel: cancelHeartbeat,
      retry: retryHeartbeat,
    });
    return NextResponse.json(await service.delete(id, { confirmed }));
  } catch (error) { return lifecycleError(error); }
}
