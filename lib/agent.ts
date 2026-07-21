import { nexotao } from "./nexotao";
import { TOOL_DEFS, executeTool, isMutating } from "./tools";
import { saveSessionMessages, addTask, updateTask, addAgentRun } from "./store";
import type { Run } from "./run-manager";

type Msg = { role: "user" | "assistant"; content: any };
type Agent = { name: string; scope: string };

const SPAWN_TOOL = {
  name: "spawn_agents",
  description:
    "For a LARGE task, split it into independent sub-agents that run in parallel. Each sub-agent gets its own scope and works in the same project. Use dependsOn for a sub-agent that must wait for others (e.g. Tests wait on Backend and Frontend). For small tasks, do NOT spawn — just use the file tools yourself.",
  input_schema: {
    type: "object",
    properties: {
      agents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short name, e.g. Backend, Frontend, Tests" },
            task: { type: "string", description: "What this sub-agent should do" },
            dependsOn: { type: "array", items: { type: "string" } },
          },
          required: ["name", "task"],
        },
      },
    },
    required: ["agents"],
  },
} as const;

function baseSystem(root: string) {
  return `You are a coding agent running locally on the user's machine, working inside the project at ${root}. You have tools: list_dir, read_file, write_file, edit_file, bash, grep, web_search, web_fetch. Use web_search for up-to-date info and web_fetch to read a URL (docs, articles, GitHub). Actually make changes — read before you edit. Keep messages short. End with a one or two sentence summary.`;
}

/** Core tool loop for one agent. Returns the final turn's text (its summary). */
async function toolLoop(opts: {
  run: Run;
  client: ReturnType<typeof nexotao>;
  model: string;
  system: string;
  convo: Msg[];
  root: string;
  thread: string;
  approvalOn: boolean;
  toolDefs?: any[];
  extraTools?: any[];
  onSpawn?: (input: any) => Promise<{ output: string }>;
  handlers?: Record<string, (input: any) => Promise<{ output: string }>>;
  onProgress?: (text: string) => void;
  maxIters?: number;
}): Promise<string> {
  const { run, client, model, system, convo, root, thread, approvalOn, toolDefs = TOOL_DEFS as any, extraTools = [], onSpawn, handlers = {}, onProgress, maxIters = 24 } = opts;
  let full = "";

  for (let iter = 0; iter < maxIters; iter++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      system,
      tools: [...toolDefs, ...extraTools],
      messages: convo as any,
    });
    stream.on("text", (t: string) => { full += t; run.push({ type: "text", text: t, thread }); onProgress?.(full); });
    const final = await stream.finalMessage();
    onProgress?.(full);

    convo.push({ role: "assistant", content: final.content });
    const toolUses = (final.content as any[]).filter((b) => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) return full;

    const results: any[] = [];
    for (const tu of toolUses) {
      run.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input, thread });

      let out: { ok: boolean; output: string; [k: string]: any };
      if (tu.name === "spawn_agents" && onSpawn) {
        const r = await onSpawn(tu.input);
        out = { ok: true, output: r.output };
      } else if (handlers[tu.name]) {
        const r = await handlers[tu.name](tu.input);
        out = { ok: true, output: r.output };
      } else {
        let decision: "allow" | "deny" = "allow";
        if (approvalOn && isMutating(tu.name)) {
          run.push({ type: "approval", id: tu.id, name: tu.name, input: tu.input, thread });
          decision = await run.awaitApproval(tu.id);
        }
        out =
          decision === "deny"
            ? { ok: false, output: "The user denied this action." }
            : await executeTool(tu.name, tu.input, root);
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
export async function runAgent(opts: { run: Run; messages: Msg[]; model: string; apiKey: string; root: string; approvalOn: boolean; sessionId?: string }) {
  const client = nexotao(opts.apiKey);
  const { sessionId, messages } = opts;

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
      client,
      model: opts.model,
      system: baseSystem(opts.root),
      convo: [...messages],
      root: opts.root,
      thread: "agent",
      approvalOn: opts.approvalOn,
      onProgress: (full) => persist(full),
    });
    persist(text || "(no response)", true);
    opts.run.push({ type: "done" });
  } catch (e: any) {
    opts.run.push({ type: "error", error: String(e?.message ?? e) });
  }
}

/** Multi-agent: a Lead that can spawn task-scoped sub-agents which run in parallel.
 * Every sub-agent's work is logged to the Task board (in_progress → done) and to
 * agent history, so the board shows live: what's running and how many are done. */
export async function runAgentMulti(opts: { run: Run; messages: Msg[]; model: string; apiKey: string; root: string; agents?: Agent[]; projectId?: string }) {
  const { run, model, root, projectId } = opts;
  const client = nexotao(opts.apiKey);
  const runId = run.id;
  const prompt = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "Run";

  // task helpers (no-ops when there's no active project)
  const newTask = (title: string, agent: string) =>
    projectId ? addTask(projectId, title, { col: "in_progress", runId, agent }).then((t) => t.id).catch(() => null) : Promise.resolve(null);
  const finishTask = (idP: Promise<string | null> | string | null, ok: boolean, summary: string) => {
    Promise.resolve(idP).then((id) => { if (id) updateTask(id, { col: ok ? "done" : "review", summary: summary.slice(0, 400) }).catch(() => {}); });
  };

  const team = opts.agents?.length
    ? ` Suggested specialist roles for this project: ${opts.agents.map((a) => `${a.name} (${a.scope})`).join(", ")}.`
    : "";
  const leadSystem = `You are the LEAD agent, coordinating work on the project at ${root}.

DELEGATE BY DEFAULT. If the task touches more than one area (e.g. backend + frontend + tests, or several files/features), you MUST call spawn_agents to split it into focused specialist sub-agents that run in parallel. Decide the team from the work itself and name each agent after its scope (e.g. Backend, Frontend, Tests, Auth). Use dependsOn where one must wait for another (e.g. Tests depends on Backend and Frontend). Prefer 2-5 sub-agents. Only skip delegation for a genuinely single, small change.

Before spawning: briefly state your plan — the sub-agents you'll create and why. After they finish: integrate their work, verify it (e.g. type-check), and give a short final summary. Keep your own messages concise; the detail lives in each sub-agent.${team}`;

  async function onSpawn(input: any): Promise<{ output: string }> {
    const list: { name: string; task: string; dependsOn?: string[] }[] = input.agents ?? [];
    for (const a of list) run.push({ type: "thread_created", id: a.name, scope: a.task, dependsOn: a.dependsOn });

    const done: Record<string, string> = {};
    let pending = [...list];

    while (pending.length) {
      const ready = pending.filter((a) => (a.dependsOn ?? []).every((d) => done[d] !== undefined));
      const wave = ready.length ? ready : pending; // break cycles: run the rest
      await Promise.all(
        wave.map(async (a) => {
          run.push({ type: "thread_status", id: a.name, status: "running" });
          const taskId = newTask(a.task, a.name); // → board: In progress
          try {
            const sys = `${baseSystem(root)} You are the "${a.name}" sub-agent. Stay within your scope: ${a.task}. Work only on files relevant to this scope.`;
            const summary = await toolLoop({
              run,
              client,
              model,
              system: sys,
              convo: [{ role: "user", content: `Your task: ${a.task}` }],
              root,
              thread: a.name,
              approvalOn: false, // autonomous in multi-agent mode
            });
            done[a.name] = summary || "done";
            run.push({ type: "thread_status", id: a.name, status: "done" });
            finishTask(taskId, true, summary || "Done");
            if (projectId) addAgentRun(projectId, { agent: a.name, task: a.task, summary: (summary || "Worked on the task").slice(0, 400), ok: true }).catch(() => {});
          } catch (e: any) {
            const err = `failed: ${String(e?.message ?? e)}`;
            done[a.name] = err;
            run.push({ type: "thread_status", id: a.name, status: "error" });
            finishTask(taskId, false, err);
            if (projectId) addAgentRun(projectId, { agent: a.name, task: a.task, summary: err.slice(0, 400), ok: false }).catch(() => {});
          }
        }),
      );
      pending = pending.filter((a) => done[a.name] === undefined);
    }

    const report = list.map((a) => `- ${a.name}: ${done[a.name]}`).join("\n");
    return { output: `Sub-agents finished:\n${report}` };
  }

  const leadTask = newTask(prompt, "Lead"); // the run's own board card
  try {
    run.push({ type: "status", status: "running" });
    const text = await toolLoop({
      run,
      client,
      model,
      system: leadSystem,
      convo: [...opts.messages],
      root,
      thread: "lead",
      approvalOn: false,
      extraTools: [SPAWN_TOOL],
      onSpawn,
    });
    finishTask(leadTask, true, text || "Done");
    run.push({ type: "done" });
  } catch (e: any) {
    finishTask(leadTask, false, String(e?.message ?? e));
    run.push({ type: "error", error: String(e?.message ?? e) });
  }
}

/* ── Paperclip-style control-plane heartbeat ───────────────────────────────
 * One agent executing one issue. The executor calls this; the lead's plan
 * phase delegates via `delegate` (creating child issues), workers execute,
 * and the lead's integrate phase verifies + summarizes. */

const READ_TOOL_NAMES = ["list_dir", "read_file", "grep", "web_search", "web_fetch"];
const READ_TOOLS = (TOOL_DEFS as unknown as any[]).filter((t) => READ_TOOL_NAMES.includes(t.name));

const DELEGATE_TOOL = {
  name: "delegate",
  description:
    "Split the goal into concrete sub-tasks for your specialist workers, who run in parallel. Call this exactly once with all sub-tasks.",
  input_schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            assignee: { type: "string", description: "Worker name to assign, e.g. Backend" },
            title: { type: "string", description: "Short task title" },
            detail: { type: "string", description: "Precisely what this worker should build" },
            dependsOn: { type: "array", items: { type: "string" }, description: "Worker names this task must wait for" },
          },
          required: ["assignee", "title"],
        },
      },
    },
    required: ["tasks"],
  },
} as const;

export type IssueAgentMode = "lead-plan" | "lead-integrate" | "worker";

export async function runIssueAgent(opts: {
  run: Run;
  apiKey: string;
  model: string;
  root: string;
  mode: IssueAgentMode;
  agentName: string;
  agentScope: string;
  goal: string;
  detail: string;
  workers?: { name: string; scope: string }[];
  childrenReport?: string;
  onDelegate?: (tasks: any[]) => Promise<{ output: string }>;
}): Promise<{ text: string; delegated: boolean }> {
  const client = nexotao(opts.apiKey);
  const thread = opts.mode === "worker" ? opts.agentName : "lead";
  const hasDetail = opts.detail && opts.detail !== opts.goal;
  let delegated = false;
  const handlers: Record<string, (i: any) => Promise<{ output: string }>> = {};
  let system: string;
  let toolDefs: any[] = TOOL_DEFS as any;
  let extraTools: any[] = [];
  let convo: Msg[];

  if (opts.mode === "lead-plan") {
    const team = (opts.workers ?? []).map((w) => `- ${w.name}: ${w.scope}`).join("\n");
    system = `You are the LEAD agent for the project at ${opts.root}. Your job is to PLAN and DELEGATE — you do NOT write code yourself. Explore the project with the read-only tools if useful, then call the delegate tool exactly ONCE to split the goal into concrete sub-tasks for your specialist workers. Assign each sub-task to the best-matching worker by name, give it a clear title + detailed instructions, and set dependsOn (worker names) when one must wait for another (e.g. Tests dependsOn Backend and Frontend). Prefer 2-5 sub-tasks. After delegating, write a short one-paragraph plan.\n\nYour workers:\n${team || "- (no specialists configured; assign everything to a single worker named after the area)"}`;
    toolDefs = READ_TOOLS;
    extraTools = [DELEGATE_TOOL];
    handlers["delegate"] = async (input) => {
      delegated = true;
      return opts.onDelegate ? opts.onDelegate(input.tasks ?? []) : { output: "delegated" };
    };
    convo = [{ role: "user", content: `Goal: ${opts.goal}${hasDetail ? `\n\n${opts.detail}` : ""}\n\nPlan the work and delegate it to your workers.` }];
  } else if (opts.mode === "lead-integrate") {
    system = `You are the LEAD agent for the project at ${opts.root}. Your specialist workers have finished their sub-tasks. Review their results, integrate the work, and VERIFY it (you may run a type-check or tests via bash). Fix small integration gaps if needed. Then give a concise final summary of what was built.`;
    convo = [{ role: "user", content: `Original goal: ${opts.goal}\n\nYour team's results:\n${opts.childrenReport ?? "(none)"}\n\nIntegrate, verify, and summarize.` }];
  } else {
    system = `${baseSystem(opts.root)} You are the "${opts.agentName}" specialist on a team. Your scope: ${opts.agentScope}. Do ONLY your assigned task, editing just the files relevant to it. End with a short summary of what you changed.`;
    convo = [{ role: "user", content: `Your task: ${opts.goal}${hasDetail ? `\n\n${opts.detail}` : ""}` }];
  }

  const text = await toolLoop({
    run: opts.run, client, model: opts.model, system, convo, root: opts.root, thread,
    approvalOn: false, toolDefs, extraTools, handlers,
  });
  return { text: text || "(done)", delegated };
}
