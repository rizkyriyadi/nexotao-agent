import { streamAssistantTurn } from "./turn";
import { TOOL_DEFS, executeTool } from "./tools";
import { authorizeTool, modeToPolicy, modeSystemDirective, DEFAULT_MODE, type ExecutionPolicy, type AgentMode } from "./execution-policy";
import { safeError } from "./redact";
import { saveSessionMessages } from "./store";
import type { Run } from "./run-manager";

type Msg = { role: "user" | "assistant"; content: any };

function baseSystem(root: string) {
  return `You are a coding agent running locally on the user's machine, working inside the project at ${root}. You have tools: list_dir, read_file, write_file, edit_file, bash, grep, web_search, web_fetch. Use web_search for up-to-date info and web_fetch to read a URL (docs, articles, GitHub). Actually make changes — read before you edit. Keep messages short. End with a one or two sentence summary.`;
}

/** Core tool loop for one agent. Returns the final turn's text (its summary). */
async function toolLoop(opts: {
  run: Run;
  apiKey: string;
  model: string;
  system: string;
  convo: Msg[];
  root: string;
  thread: string;
  approvalPolicy: ExecutionPolicy;
  toolDefs?: any[];
  extraTools?: any[];
  onSpawn?: (input: any) => Promise<{ output: string }>;
  handlers?: Record<string, (input: any) => Promise<{ output: string }>>;
  onProgress?: (text: string) => void;
  beforeMutation?: (tool: { name: string; input: unknown }) => Promise<void>;
  maxIters?: number;
}): Promise<string> {
  const { run, apiKey, model, system, convo, root, thread, approvalPolicy, toolDefs = TOOL_DEFS as any, extraTools = [], onSpawn, handlers = {}, onProgress, beforeMutation, maxIters = 24 } = opts;
  let full = "";

  for (let iter = 0; iter < maxIters; iter++) {
    const turn = await streamAssistantTurn({
      apiKey,
      model,
      system,
      tools: [...toolDefs, ...extraTools],
      messages: convo,
      signal: run.signal,
      onText: (t: string) => { full += t; run.push({ type: "text", text: t, thread }); onProgress?.(full); },
    });
    onProgress?.(full);
    run.push({ type: "usage", inputTokens: turn.usage.input_tokens, outputTokens: turn.usage.output_tokens, thread });

    convo.push({ role: "assistant", content: turn.content });
    const toolUses = (turn.content as any[]).filter((b) => b.type === "tool_use");
    if (turn.stop_reason !== "tool_use" || toolUses.length === 0) return full;

    const results: any[] = [];
    for (const tu of toolUses) {
      run.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input, thread });

      let out: { ok: boolean; output: string; [k: string]: any };
      const allowed = await authorizeTool(run, approvalPolicy, { id: tu.id, name: tu.name, input: tu.input, thread });
      if (!allowed) {
        out = { ok: false, output: "The user denied this action." };
      } else if (tu.name === "spawn_agents" && onSpawn) {
        const r = await onSpawn(tu.input);
        out = { ok: true, output: r.output };
      } else if (handlers[tu.name]) {
        const r = await handlers[tu.name](tu.input);
        out = { ok: true, output: r.output };
      } else {
        out = await executeTool(tu.name, tu.input, root, run.signal, beforeMutation);
      }

      run.push({
        type: "tool_result",
        id: tu.id,
        name: tu.name,
        ok: out.ok,
        display: out.display,
        kind: out.kind,
        file: out.file,
        content: out.content,
        output: out.output,
        thread,
      });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.output.slice(0, 60_000), is_error: !out.ok });
    }
    convo.push({ role: "user", content: results });
  }
  return full || "(stopped after 24 steps)";
}

/** Single agent. Persists to the session store on the SERVER, so a client
 * refresh/disconnect never loses the prompt or the reply. */
export async function runAgent(opts: { run: Run; messages: Msg[]; model: string; apiKey: string; root: string; mode?: AgentMode; sessionId?: string }) {
  const { sessionId, messages } = opts;
  const mode = opts.mode ?? DEFAULT_MODE;

  // incrementally persist the assistant reply as it streams, so a refresh or
  // disconnect mid-run keeps whatever the agent has produced so far.
  let lastSave = 0;
  const persist = (assistantText: string, force = false) => {
    if (!sessionId) return;
    const now = Date.now();
    if (!force && now - lastSave < 600) return;
    lastSave = now;
    saveSessionMessages(sessionId, [...messages, { role: "assistant", content: assistantText || "…" }] as any).catch(() => {});
  };

  try {
    opts.run.push({ type: "status", status: "running" });
    if (sessionId) await saveSessionMessages(sessionId, messages as any).catch(() => {});
    const text = await toolLoop({
      run: opts.run,
      apiKey: opts.apiKey,
      model: opts.model,
      system: baseSystem(opts.root) + modeSystemDirective(mode),
      convo: [...messages],
      root: opts.root,
      thread: "agent",
      approvalPolicy: modeToPolicy(mode),
      onProgress: (full) => persist(full),
    });
    persist(text || "(no response)", true);
    opts.run.push({ type: "done" });
  } catch (e: any) {
    opts.run.push({ type: "error", error: safeError(e) });
  }
}

/* ── Control-plane heartbeat ────────────────────────────────────────────────
 * A single lead agent (Hutao) executes one task end-to-end, in the mode the
 * user chose in the control panel. Follow-up messages continue the same task as
 * an ongoing conversation. */

export type IssueAgentMode =
  | "lead-execute"  // Agent mode: the lead builds directly (full tools, auto-approve).
  | "lead-plan-doc" // Plan mode: the lead investigates read-only and writes a plan.
  | "lead-ask";     // Ask mode: the lead answers read-only, changing nothing.

export async function runIssueAgent(opts: {
  run: Run;
  apiKey: string;
  model: string;
  root: string;
  mode: IssueAgentMode;
  agentName: string;
  /** The full conversation so far, ending with the user turn to act on. */
  messages: Msg[];
  beforeMutation?: (tool: { name: string; input: unknown }) => Promise<void>;
}): Promise<{ text: string }> {
  // The chosen run mode maps to the shared execution policy: agent → auto
  // approve (destructive still gated), plan/ask → deny every mutation.
  const runMode: AgentMode = opts.mode === "lead-ask" ? "ask" : opts.mode === "lead-plan-doc" ? "plan" : "agent";
  const approvalPolicy = modeToPolicy(runMode);
  const system = `${baseSystem(opts.root)} You are ${opts.agentName}, the lead agent handling the user's request directly. Work on it end-to-end and finish with a short summary.${modeSystemDirective(runMode)}`;
  const text = await toolLoop({
    run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo: [...opts.messages], root: opts.root,
    thread: "lead", beforeMutation: opts.beforeMutation, approvalPolicy,
  });
  return { text: text || "(done)" };
}
