import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { getConfig } from "@/lib/config";
import { getActiveProject } from "@/lib/store";
import { DEFAULT_MODEL } from "@/lib/nexotao";
import { expandHome } from "@/lib/paths";
import { createRun } from "@/lib/run-manager";
import { runAgent, runAgentMulti } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 800;

type Msg = { role: "user" | "assistant"; content: string };

/** Starts a durable, backend-owned run and returns its id immediately.
 * The run keeps executing regardless of whether the client stays connected —
 * the browser (re)connects to GET /api/run/stream to replay + tail live. */
export async function POST(req: Request) {
  const { messages, multi, sessionId } = (await req.json()) as { messages: Msg[]; multi?: boolean; sessionId?: string };
  const cfg = await getConfig();
  if (!cfg.apiKey) {
    return new Response(JSON.stringify({ error: "No Nexotao API key. Finish onboarding first." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const project = await getActiveProject();
  const root = expandHome(project?.path || process.cwd());
  await fs.mkdir(root, { recursive: true }).catch(() => {});

  const useMulti = multi ?? project?.mode === "multi";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const runId = randomUUID();
  const run = createRun(runId, sessionId, {
    kind: useMulti ? "orchestrator" : "chat",
    title: (lastUser?.content || "Run").slice(0, 80),
    projectId: project?.id ?? "",
  });
  run.push({ type: "run", runId });

  // fire-and-forget: this promise floats past the response and runs to
  // completion on the event loop even after the browser disconnects.
  if (useMulti) {
    runAgentMulti({ run, messages, model: cfg.model || DEFAULT_MODEL, apiKey: cfg.apiKey, root, agents: project?.agents, projectId: project?.id });
  } else {
    runAgent({ run, messages, model: cfg.model || DEFAULT_MODEL, apiKey: cfg.apiKey, root, approvalOn: true, sessionId });
  }

  return new Response(JSON.stringify({ runId }), {
    headers: { "Content-Type": "application/json" },
  });
}
