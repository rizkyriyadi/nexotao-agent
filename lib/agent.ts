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

/** How many times in a row a turn may hit the output ceiling before the loop
 *  gives up. Writing one large file legitimately takes two or three passes; a
 *  model that is cut off every single turn is not making progress, and letting
 *  that run to the step ceiling burns the user's balance to reach the same
 *  answer. Reset by any turn that completes on its own. */
const MAX_CONSECUTIVE_CUTOFFS = 4;

/** What to do with a turn the model was cut off in the middle of.
 *
 *  When a turn ends on `max_tokens` the last content block is whatever was
 *  in-flight when the ceiling hit. If that is a `tool_use`, its arguments are
 *  half-parsed — we saw `write_file` arrive with a `path` and no `content` at
 *  all, which would have written an empty file over the real one.
 *
 *  So *every* tool call in the turn is dropped, not just the truncated one. The
 *  API rejects a `tool_use` with no matching `tool_result`, and this loop is
 *  about to reply with a text nudge rather than results — so leaving an earlier,
 *  fully-formed call in place would 400 the very next request and turn a
 *  recoverable cutoff into a failed run. Nothing is lost: the model reissues the
 *  calls when it continues, and it is told plainly that none of them ran.
 *
 *  The text placeholder covers the other half of the same rule: an assistant
 *  message with no content at all is rejected too, which is what a turn that had
 *  emitted nothing but its opening tool call would leave behind. */
export function resumeAfterCutoff(content: any[]): { content: any[]; nudge: string } {
  const blocks = content.filter((b) => b?.type !== "tool_use");
  // The truncated call is always the last one: everything before it finished
  // streaming before the ceiling was reached.
  const droppedTools = content.filter((b) => b?.type === "tool_use").map((b) => String(b.name));
  const cutOff = droppedTools[droppedTools.length - 1];

  if (!blocks.length) blocks.push({ type: "text", text: "…" });

  // Naming the calls matters more than it looks: told only "continue", the model
  // would sometimes carry on as though its write had landed.
  const dropped = droppedTools.length > 1
    ? `your ${droppedTools.join(", ")} calls were discarded`
    : `that ${cutOff} call was discarded`;

  const nudge = cutOff
    ? `Your reply hit the output size limit part-way through a ${cutOff} call, so ${dropped} — nothing ran and nothing was written. Pick up exactly where you left off. If you were writing a large file, do not try to emit it in one call: write the first section with write_file, then append the rest with further edit_file calls.`
    : "Your reply hit the output size limit and was cut off mid-sentence. Continue from exactly where you stopped — do not start over or repeat what you already wrote.";

  return { content: blocks, nudge };
}

/** What one agent loop produced. `completion` distinguishes an agent that
 *  stopped because it was finished from one that ran out of steps; the caller
 *  needs that difference to decide whether the task may be marked done. */
export type LoopResult = { text: string; completion: RunCompletion };

/** Core tool loop for one agent. Returns the final turn's text (its summary).
 *  Exported for tests — see the `streamTurn` seam below. */
export async function toolLoop(opts: {
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
  /** Seam for tests: how one assistant turn is produced. Defaults to the real
   *  provider. The cutoff handling below is loop *sequencing* — which branch a
   *  stop reason takes, and in what order — so it cannot be covered by testing
   *  the helpers alone; a test has to be able to say "this turn came back
   *  truncated" and watch what the loop does next. */
  streamTurn?: typeof streamAssistantTurn;
}): Promise<LoopResult> {
  const { run, apiKey, model, system, convo, root, thread, approvalPolicy, toolDefs = TOOL_DEFS as any, extraTools = [], handlers = {}, onProgress, beforeMutation, maxIters = DEFAULT_MAX_ITERS, streamTurn = streamAssistantTurn } = opts;
  let full = "";
  let cutoffs = 0;

  for (let iter = 0; iter < maxIters; iter++) {
    const turn = await streamTurn({
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

    // A turn cut off at the output ceiling is not an answer, and — this is the
    // bug users actually hit — it is not a stop either. The model was mid-write
    // of a large file; asking it to continue is the whole fix. Checked before
    // the tool_use branch below, because a truncated turn's trailing tool_use
    // carries half-parsed arguments and must never be executed.
    if (turn.stop_reason === "max_tokens") {
      const { content, nudge } = resumeAfterCutoff(turn.content as any[]);
      convo.push({ role: "assistant", content });
      convo.push({ role: "user", content: nudge });
      run.push({ type: "text", text: "\n", thread });
      if (++cutoffs >= MAX_CONSECUTIVE_CUTOFFS) return { text: full, completion: "truncated" };
      continue;
    }
    cutoffs = 0;

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

/** One final turn with no tools, for a run that stopped mid-task: what got done,
 *  what did not, and the one step to take next.
 *
 *  Only for that case. A run that finished has already answered — the system
 *  prompt tells the agent to close with a summary of its own — and asking the
 *  model to summarise its own summary bought a second copy of the same answer in
 *  different words, at the price of one full-conversation request per run. A run
 *  cut off at the step limit is the opposite: the text so far is not an answer,
 *  it stops in the middle of a thought, and nothing else in the transcript can
 *  say what was left undone.
 *
 *  Never throws: a run that did the work must not fail on its epilogue. */
async function writeUnfinishedReport(opts: {
  run: Run;
  apiKey: string;
  model: string;
  system: string;
  convo: Msg[];
  thread: string;
}): Promise<string> {
  const { run, apiKey, model, system, convo, thread } = opts;
  const ask = "You have run out of steps for this run. Write a short report for the user: what you completed, what is still unfinished, and the single next step. Plain prose, no tools.";
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
    // One that finished does not: its own last turn is already the answer.
    const summary = completion === "truncated"
      ? await writeUnfinishedReport({ run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo, thread: "agent" })
      : "";
    if (summary) opts.run.push({ type: "summary", text: summary, thread: "agent" });
    const reply = [text, summary].filter(Boolean).join("\n\n");
    persist(reply || "(no response)", true);
    opts.run.push({ type: "done" });
  } catch (e: any) {
    opts.run.push({ type: "error", error: safeError(e) });
  }
}

/* ── Control-plane heartbeat ────────────────────────────────────────────────
 * The agent (Hutao) handles the task in the mode the user chose in the control
 * panel, end to end. Follow-up messages continue the same task as an ongoing
 * conversation. */

export type IssueAgentMode =
  | "lead-execute"  // Agent mode: the agent builds directly (full tools, auto-approve).
  | "lead-plan-doc" // Plan mode: the agent investigates read-only and writes a plan.
  | "lead-ask";     // Ask mode: the agent answers read-only, changing nothing.

/** Rewrite any absolute path into the project folder as a project-relative one,
 *  for text that outlives the run.
 *
 *  A summary quoting "/Users/someone/code/api/API.md" is a fact about one
 *  machine. It reads as noise to anyone whose checkout is somewhere else, and it
 *  is the kind of thing a later run will copy into a file it writes. "./API.md"
 *  is the same fact, still true on every machine, so it is rewritten on the way
 *  out. */
export function relativizeWorkspacePaths(detail: string, root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!trimmed) return detail;
  // On Windows the root arrives as `D:\Users\someone\code\api` while the model,
  // told to write POSIX paths, may echo either separator back — so both
  // spellings of the same root are stripped. Matching only `/` left every
  // Windows path untouched, which is the failure this function exists to stop.
  const spellings = new Set([trimmed, trimmed.replace(/\//g, "\\"), trimmed.replace(/\\/g, "/")]);
  let out = detail;
  // Longest-first so a trailing-separator form is consumed before the bare root.
  for (const spelling of spellings) out = out.split(`${spelling}/`).join("").split(`${spelling}\\`).join("");
  for (const spelling of spellings) out = out.split(spelling).join(".");
  return out;
}

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
}): Promise<{ text: string; summary: string; completion: RunCompletion }> {
  // The chosen run mode maps to the shared execution policy: agent → auto
  // approve (destructive still gated), plan/ask → deny every mutation.
  const runMode: AgentMode = opts.mode === "lead-ask" ? "ask" : opts.mode === "lead-plan-doc" ? "plan" : "agent";
  const approvalPolicy = modeToPolicy(runMode);

  const system = `${baseSystem(opts.root)} You are ${opts.agentName}, handling the user's request directly. Work on it end-to-end and finish with a short summary.${modeSystemDirective(runMode)}`;

  const convo: Msg[] = [...opts.messages];
  const { text, completion } = await toolLoop({
    run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo, root: opts.root,
    thread: "lead", beforeMutation: opts.beforeMutation, approvalPolicy,
    extraTools: [],
    handlers: {},
  });

  // Only a run that ran out of steps gets an epilogue. A finished one has said
  // its piece — the system prompt has it close with a summary — and a second
  // pass over the same conversation returned the same answer reworded, which
  // read as noise the user had to reconcile against what they had just read.
  const summary = completion === "truncated"
    ? await writeUnfinishedReport({ run: opts.run, apiKey: opts.apiKey, model: opts.model, system, convo, thread: "lead" })
    : "";
  if (summary) opts.run.push({ type: "summary", text: summary, thread: "lead" });

  return { text: text || "(done)", summary, completion };
}
