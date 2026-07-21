import { NextResponse } from "next/server";
import { AgentLifecycleError, AgentLifecycleService, type AgentAction } from "@/lib/agent-lifecycle";
import { getDatabase } from "@/lib/db/database";
import { cancelHeartbeat, retryHeartbeat, triggerHeartbeat } from "@/lib/executor";
import { HttpError, jsonError, readJsonObject, stringField } from "@/lib/http";

export const runtime = "nodejs";

const actions: AgentAction[] = ["pause", "resume", "terminate", "invoke", "clear_error", "retry_last_task", "restore_revision"];

function lifecycleError(error: unknown) {
  if (!(error instanceof AgentLifecycleError)) return jsonError(error);
  const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "confirmation_required" ? 428 : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(req);
    const action = stringField(body, "action", { required: true, max: 40 }) as AgentAction;
    if (!actions.includes(action)) throw new HttpError("Unknown agent action");
    const service = new AgentLifecycleService(await getDatabase(), {
      invoke: (input) => triggerHeartbeat({ ...input, reason: "invoke" }),
      cancel: cancelHeartbeat,
      retry: retryHeartbeat,
    });
    if (action === "restore_revision") {
      const revision = Number(body.revision);
      if (!Number.isInteger(revision) || revision < 1) throw new HttpError("revision must be a positive integer");
      return NextResponse.json({ agent: await service.restore(id, revision) });
    }
    const issueId = body.issueId === undefined ? undefined : stringField(body, "issueId", { max: 100 });
    const agent = await service.action(id, action, { confirmed: body.confirmed === true, issueId });
    return NextResponse.json({ agent });
  } catch (error) { return lifecycleError(error); }
}
