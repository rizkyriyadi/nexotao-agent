import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { getConfig } from "@/lib/config";
import { getActiveProject } from "@/lib/store";
import { DEFAULT_MODEL } from "@/lib/nexotao";
import { expandHome } from "@/lib/paths";
import { createRun } from "@/lib/run-manager";
import { runAgent } from "@/lib/agent";
import { AGENT_MODES, DEFAULT_MODE, type AgentMode } from "@/lib/execution-policy";

export const runtime = "nodejs";
export const maxDuration = 800;

type Msg = { role: "user" | "assistant"; content: string };

/** Starts a durable, backend-owned run and returns its id immediately.
 * The run keeps executing regardless of whether the client stays connected —
 * the browser (re)connects to GET /api/run/stream to replay + tail live. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { messages?: unknown; sessionId?: unknown; mode?: unknown } | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100 || !body.messages.every((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length <= 100_000)) {
    return new Response(JSON.stringify({ error: "messages must be a non-empty valid message array" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length > 100)) return new Response(JSON.stringify({ error: "invalid sessionId" }), { status: 400 });
  if (body.mode !== undefined && !AGENT_MODES.includes(body.mode as AgentMode)) return new Response(JSON.stringify({ error: "mode must be agent, plan, or ask" }), { status: 400 });
  const messages = body.messages as Msg[];
  const sessionId = body.sessionId as string | undefined;
  const cfg = await getConfig();
  const mode = (body.mode as AgentMode | undefined) ?? cfg.defaultMode ?? DEFAULT_MODE;
  if (!cfg.apiKey) {
    return new Response(JSON.stringify({ error: "No Nexotao API key. Finish onboarding first." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const project = await getActiveProject();
  const root = expandHome(project?.path || process.cwd());
  await fs.mkdir(root, { recursive: true }).catch(() => {});

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const runId = randomUUID();
  const run = createRun(runId, sessionId, {
    kind: "chat",
    title: (lastUser?.content || "Run").slice(0, 80),
    projectId: project?.id ?? "",
  });
  run.push({ type: "run", runId });

  // fire-and-forget: this promise floats past the response and runs to
  // completion on the event loop even after the browser disconnects.
  runAgent({ run, messages, model: cfg.model || DEFAULT_MODEL, apiKey: cfg.apiKey, root, mode, sessionId });

  return new Response(JSON.stringify({ runId }), {
    headers: { "Content-Type": "application/json" },
  });
}
