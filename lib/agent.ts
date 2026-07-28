import { streamAssistantTurn } from "./turn";
import { TOOL_DEFS, executeTool } from "./tools";
import { authorizeTool, modeToPolicy, modeSystemDirective, DEFAULT_MODE, type ExecutionPolicy, type AgentMode } from "./execution-policy";
import { safeError } from "./redact";
import { saveSessionMessages } from "./store";
import type { Run } from "./run-manager";
import type { RunCompletion } from "./run-transcript";

type Msg = { role: "user" | "assistant"; content: any };

function baseSystem(root: string) {
  return `You are a coding agent running locally on the user's machine, working inside the project at ${root}. You have tools: list_dir, read_file, write_file, edit_file, bash, grep, web_search, web_fetch, graph_query, graph_path, graph_explain. Use web_search for up-to-date info and web_fetch to read a URL (docs, articles, GitHub). Before reading files or starting work, call graph_query to check what the codebase and past task history already know about this — prefer the graph over blind file reads; use graph_path to see how two things connect and graph_explain to inspect one node. Actually make changes — read before you edit. Keep messages short. End with a one or two sentence summary.`;
}

/** How many tool-using turns one agent gets before the loop stops it. Real build
 *  tasks routinely spend 20+ turns just reading and installing, so the old
 *  ceiling of 24 cut agents off mid-sentence and the run was then filed as
 *  "done". Raised, and — more importantly — hitting it is now reported rather
 *  than silently passed off as a finished answer. */
const DEFAULT_MAX_ITERS = 60;

/** What one agent loop produced. `completion` distinguishes an agent that
 *  stopped because it was finished from one that ran out of steps; the caller
 *  needs that difference to decide whether the task may be marked done. */
export type LoopResult = { text: string; completion: RunCompletion };

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
  handlers?: Record<string, (input: any) => Promise<{ output: string }>>;
  onProgress?: (text: string) => void;
  beforeMutation?: (tool: { name: string; input: unknown }) => Promise<void>;
  maxIters?: number;
}): Promise<LoopResult> {
  const { run, apiKey, model, system, convo, root, thread, approvalPolicy, toolDefs = TOOL_DEFS as any, extraTools = [], handlers = {}, onProgress, beforeMutation, maxIters = DEFAULT_MAX_ITERS } = opts;
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
    if (turn.stop_reason !== "tool_use" || toolUses.length === 0) return { text: full, completion: "complete" };

    const results: any[] = [];
    for (const tu of toolUses) {
      run.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input, thread });

      let out: { ok: boolean; output: string; [k: string]: any };
      const allowed = await authorizeTool(run, approvalPolicy, { id: tu.id, name: tu.name, input: tu.input, thread });
      if (!allowed) {
        out = { ok: false, output: "The user denied this action." };
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
  // Out of steps with tool calls still pending. The agent was mid-task, so the
  // text so far is not an answer — say so, and let the caller file the run as
  // needing review rather than done.
  return { text: full, completion: "truncated" };
}

/** One final turn with no tools, asking the agent to report back. Its own words,
 *  written knowing the work is over — which is what the user actually wants at
 *  the end of a run, and what a stream of mid-task thinking never gave them.
 *  Never throws: a run that did the work must not fail on its epilogue. */
async function writeClosingSummary(opts: {
  run: Run;
  apiKey: string;
  model: string;
  system: string;
  convo: Msg[];
  thread: string;
  truncated: boolean;
}): Promise<string> {
  const { run, apiKey, model, system, convo, thread, truncated } = opts;
  const ask = truncated
    ? "You have run out of steps for this run. Write a short report for the user: what you completed, what is still unfinished, and the single next step. Plain prose, no tools."
    : "The work is done. Write a short report for the user: what you did, anything they should know, and what to check. Plain prose, no tools.";
  try {
    const turn = await streamAssistantTurn({
      apiKey, model, system,
      messages: [...convo, { role: "user", content: ask }],
      signal: run.signal,
      maxTokens: 1024,
    });
    const text = (turn.content as any[])
      .filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("").trim();
    run.push({ type: "usage", inputTokens: turn.usage.input_tokens, outputTokens: turn.usage.output_tokens, thread });
    return text;
  } catch {
    return "";
  }
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
    const system = baseSystem(opts.root) + modeSystemDirective(mode);
    // toolLoop appends to this array, so after it returns we hold the full
    // conversation — exactly what the closing turn needs to summarise.
    const convo: Msg[] = [...messages];
    const { text, completion } = await toolLoop({
      run: opts.run,
      apiKey: opts.apiKey,
      model: opts.model,
      system,
      convo,
      root: opts.root,
      thread: "agent",
      approvalPolicy: modeToPolicy(mode),
      onProgress: (full) => persist(full),
    });
    // Even in chat, a run that stopped mid-task owes the user a word about it.
    const summary = await writeClosingSummary({
      run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo,
      thread: "agent", truncated: completion === "truncated",
    });
    if (summary) opts.run.push({ type: "summary", text: summary, thread: "agent" });
    const reply = [text, summary].filter(Boolean).join("\n\n");
    persist(reply || "(no response)", true);
    opts.run.push({ type: "done" });
  } catch (e: any) {
    opts.run.push({ type: "error", error: safeError(e) });
  }
}

/* ── Control-plane heartbeat ────────────────────────────────────────────────
 * A lead agent (Hutao) handles the task in the mode the user chose in the
 * control panel. On a multi-agent project it may also hand pieces of the work to
 * its teammates; on a single-agent one it does everything itself. Follow-up
 * messages continue the same task as an ongoing conversation. */

export type IssueAgentMode =
  | "lead-execute"  // Agent mode: the lead builds directly (full tools, auto-approve).
  | "lead-plan-doc" // Plan mode: the lead investigates read-only and writes a plan.
  | "lead-ask";     // Ask mode: the lead answers read-only, changing nothing.

/** A task handed to a teammate. The `ref` is what the user sees and the `id` is
 *  what the UI links to, so both travel back to the transcript. */
export type DelegatedTask = { id: string; ref: string; title: string; assignee: string };

/** Creates the sub-task. Supplied by the executor, which owns project context;
 *  agent.ts only knows the shape. Returning a rejection message instead of
 *  throwing lets the agent recover (e.g. a name that matches no teammate). */
export type DelegateFn = (input: { title: string; detail?: string; assignee?: string })
  => Promise<{ ok: true; task: DelegatedTask } | { ok: false; error: string }>;

/** Rewrite any absolute path into the *lead's* workspace as a project-relative
 *  one, for text about to be handed to a teammate.
 *
 *  Every run gets its own copy of the project, so the lead's root does not exist
 *  for anyone else. A lead that writes "create /…/worktrees/nx-12-<runId>/API.md"
 *  into a sub-task sends the teammate to a directory outside its own workspace:
 *  the file gets written, the teammate reports success, and the teammate's branch
 *  is empty — so nothing integrates and the user is told three files were created
 *  while their folder holds none. Asking the model nicely is not enough when the
 *  failure is this quiet, so the path is rewritten on the way out. */
export function relativizeWorkspacePaths(detail: string, root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  if (!trimmed) return detail;
  // Longest-first so a trailing-slash form is consumed before the bare root.
  return detail
    .split(`${trimmed}/`).join("")
    .split(trimmed).join(".");
}

/** Tool definition for handing work to a teammate. Only offered when the project
 *  actually has teammates to hand it to — a lone agent seeing this tool would
 *  delegate to itself and deadlock. */
const DELEGATE_TOOL = {
  name: "delegate",
  description:
    "Hand one self-contained piece of this task to a teammate as its own tracked sub-task. Use it when work splits cleanly and can proceed independently. Each call creates one sub-task the user can open and follow. Tell the user which sub-tasks you created and what each covers. Your teammate works in its own separate copy of the project, so describe every file by its path relative to the project root — an absolute path from your copy does not exist in theirs.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short imperative title, e.g. 'Build the billing page'" },
      detail: { type: "string", description: "Everything the teammate needs to do it without asking you. Use project-relative paths only (e.g. 'docs/api.md', never '/home/…/docs/api.md')." },
      assignee: { type: "string", description: "Teammate name. Omit to let the control plane pick." },
    },
    required: ["title", "detail"],
  },
} as const;

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
  /** Teammates this agent may hand work to. Empty / absent = no delegation. */
  teammates?: string[];
  delegate?: DelegateFn;
}): Promise<{ text: string; summary: string; completion: RunCompletion; delegated: DelegatedTask[] }> {
  // The chosen run mode maps to the shared execution policy: agent → auto
  // approve (destructive still gated), plan/ask → deny every mutation.
  const runMode: AgentMode = opts.mode === "lead-ask" ? "ask" : opts.mode === "lead-plan-doc" ? "plan" : "agent";
  const approvalPolicy = modeToPolicy(runMode);
  // Delegation is a control-plane write, so it is offered only in Agent mode —
  // Plan and Ask promise to change nothing, and creating tasks changes things.
  const teammates = opts.teammates ?? [];
  const canDelegate = Boolean(opts.delegate) && teammates.length > 0 && opts.mode === "lead-execute";

  const delegated: DelegatedTask[] = [];
  const handlers: Record<string, (input: any) => Promise<{ output: string }>> = {};
  if (canDelegate) {
    handlers.delegate = async (input: any) => {
      const result = await opts.delegate!({
        title: String(input?.title ?? "").trim(),
        detail: typeof input?.detail === "string" ? relativizeWorkspacePaths(input.detail, opts.root) : undefined,
        assignee: typeof input?.assignee === "string" ? input.assignee : undefined,
      });
      if (!result.ok) return { output: `Could not delegate: ${result.error}` };
      delegated.push(result.task);
      opts.run.push({ type: "task_delegated", ...result.task, thread: "lead" });
      return { output: `Created ${result.task.ref} "${result.task.title}", assigned to ${result.task.assignee}. It runs on its own; do not do this work yourself.` };
    };
  }

  const team = canDelegate
    ? ` Your teammates are ${teammates.join(", ")}. For work that splits cleanly into independent pieces, use the delegate tool to give each piece to a teammate as its own sub-task, then say which sub-task covers what. Do the rest yourself.`
    : "";
  const system = `${baseSystem(opts.root)} You are ${opts.agentName}, the lead agent handling the user's request directly. Work on it end-to-end and finish with a short summary.${team}${modeSystemDirective(runMode)}`;

  const convo: Msg[] = [...opts.messages];
  const { text, completion } = await toolLoop({
    run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo, root: opts.root,
    thread: "lead", beforeMutation: opts.beforeMutation, approvalPolicy,
    extraTools: canDelegate ? [DELEGATE_TOOL] : [],
    handlers,
  });

  // The closing report is the whole point of the run for the user: it is written
  // after the work, knowing how it went, instead of trailing off mid-thought.
  const summary = await writeClosingSummary({
    run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo,
    thread: "lead", truncated: completion === "truncated",
  });
  if (summary) opts.run.push({ type: "summary", text: summary, thread: "lead" });

  return { text: text || "(done)", summary, completion, delegated };
}
