import { nexotao } from "./nexotao";
import { TOOL_DEFS, executeTool, isMutating } from "./tools";
import { saveSessionMessages } from "./store";
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
  return `You are a coding agent running locally on the user's machine, working inside the project at ${root}. You have tools: list_dir, read_file, write_file, edit_file, bash, grep. Actually make changes — read before you edit. Keep messages short. End with a one or two sentence summary.`;
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
  extraTools?: any[];
  onSpawn?: (input: any) => Promise<{ output: string }>;
  onProgress?: (text: string) => void;
}): Promise<string> {
  const { run, client, model, system, convo, root, thread, approvalOn, extraTools = [], onSpawn, onProgress } = opts;
  let full = "";

  for (let iter = 0; iter < 24; iter++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      system,
      tools: [...(TOOL_DEFS as any), ...extraTools],
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

/** Multi-agent: a Lead that can spawn task-scoped sub-agents which run in parallel. */
export async function runAgentMulti(opts: { run: Run; messages: Msg[]; model: string; apiKey: string; root: string; agents?: Agent[] }) {
  const { run, model, root } = opts;
  const client = nexotao(opts.apiKey);

  const team = opts.agents?.length
    ? ` Suggested specialist roles for this project: ${opts.agents.map((a) => `${a.name} (${a.scope})`).join(", ")}.`
    : "";
  const leadSystem = `You are the LEAD agent, coordinating work on the project at ${root}. For a big, multi-part task, call spawn_agents to split it into independent sub-agents that run in parallel (use dependsOn where one must wait for another). For a small task, just use the file tools yourself. After sub-agents finish, integrate and verify, then summarize.${team}`;

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
          } catch (e: any) {
            done[a.name] = `failed: ${String(e?.message ?? e)}`;
            run.push({ type: "thread_status", id: a.name, status: "error" });
          }
        }),
      );
      pending = pending.filter((a) => done[a.name] === undefined);
    }

    const report = list.map((a) => `- ${a.name}: ${done[a.name]}`).join("\n");
    return { output: `Sub-agents finished:\n${report}` };
  }

  try {
    run.push({ type: "status", status: "running" });
    await toolLoop({
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
    run.push({ type: "done" });
  } catch (e: any) {
    run.push({ type: "error", error: String(e?.message ?? e) });
  }
}
