"use client";

import { useState } from "react";
import { Crown, Users, ArrowUp, History, Plus, Loader2, ChevronRight, GitBranch } from "lucide-react";
import { useOrch, type Thread, type LogItem } from "./orchestrator-context";
import { agentPP, LEAD_PP } from "@/lib/avatars";
import { Markdown } from "../ui/markdown";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";

const TOOL_LABEL: Record<string, string> = {
  list_dir: "List", read_file: "Read", write_file: "Write", edit_file: "Edit",
  bash: "Run", grep: "Grep", spawn_agents: "Spawn", web_search: "Search", web_fetch: "Fetch",
};

const SUGGESTIONS = [
  "Add a login page with JWT auth",
  "Build a REST API for todos with tests",
  "Add dark mode across the app",
];

function dotClass(status: Thread["status"]) {
  return status === "running" ? "bg-electric-indigo nx-pulse" : status === "error" ? "bg-alarm-red" : status === "done" ? "bg-lichen-green" : "bg-pebble";
}

function Row({ t, selected, onSelect, lead, pp }: { t: Thread; selected: boolean; onSelect: () => void; lead?: boolean; pp: string }) {
  const tools = t.log.filter((l) => l.kind === "tool").length;
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
        selected ? "border-electric-indigo bg-electric-indigo/[0.04]" : "border-line hover:border-line-strong"
      }`}
    >
      <span className="relative block size-8 shrink-0">
        <img src={pp} alt={t.name} className="size-8 rounded-xl object-cover" />
        {lead && <Crown className="absolute -left-1 -top-1 size-3.5 rounded-full bg-warm-bone p-[1px] text-electric-indigo" />}
        <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-warm-bone ${dotClass(t.status)}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-charcoal">{t.name}</span>
          {lead && <span className="label !text-[9px]">Lead</span>}
        </span>
        <span className="block truncate text-[12.5px] text-bark-grey">{t.scope}</span>
        {t.dependsOn?.length ? <span className="mt-0.5 block font-mono text-[11px] text-pebble">waits on {t.dependsOn.join(", ")}</span> : null}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-pebble">
        {t.status === "running" ? "running" : t.status}{tools ? ` · ${tools}` : ""}
      </span>
    </button>
  );
}

type ToolItem = Extract<LogItem, { kind: "tool" }>;
type Block = { kind: "text"; text: string } | { kind: "tools"; items: ToolItem[] };

// Group consecutive tool calls so long runs read as "Ran 5 steps" accordions
// instead of a wall — narrative text stays as readable markdown between them.
function toBlocks(log: LogItem[]): Block[] {
  const blocks: Block[] = [];
  for (const it of log) {
    if (it.kind === "text") { blocks.push({ kind: "text", text: it.text }); continue; }
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "tools") last.items.push(it);
    else blocks.push({ kind: "tools", items: [it] });
  }
  return blocks;
}

function toolDot(s: string) {
  return s === "running" ? "bg-electric-indigo nx-pulse" : s === "error" ? "bg-alarm-red" : "bg-pebble";
}

function ToolRow({ it }: { it: ToolItem }) {
  return (
    <div className="flex items-center gap-3 py-[5px]">
      <span className={`size-[6px] shrink-0 rounded-full ${toolDot(it.status)}`} />
      <span className="w-12 shrink-0 text-[12.5px] font-medium text-charcoal">{TOOL_LABEL[it.name] ?? it.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-bark-grey">{it.target}</span>
      <span className="shrink-0 font-mono text-[11px] text-pebble">{it.status === "running" ? "…" : it.display ?? it.status}</span>
    </div>
  );
}

function ToolGroup({ items }: { items: ToolItem[] }) {
  const running = items.some((i) => i.status === "running");
  const [open, setOpen] = useState(items.length <= 2 || running);
  if (items.length === 1) return <div className="rounded-lg border border-line bg-paper-white px-3"><ToolRow it={items[0]} /></div>;

  // summary like "Read 3 · Run 2 · Search 1"
  const counts: Record<string, number> = {};
  for (const i of items) { const k = TOOL_LABEL[i.name] ?? i.name; counts[k] = (counts[k] ?? 0) + 1; }
  const summary = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ");

  return (
    <div className="rounded-lg border border-line bg-paper-white">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <span className={`size-[6px] shrink-0 rounded-full ${running ? "bg-electric-indigo nx-pulse" : "bg-pebble"}`} />
        <span className="text-[12.5px] font-medium text-charcoal">{items.length} steps</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-pebble">{summary}</span>
        <ChevronRight className={`size-3.5 shrink-0 text-pebble transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="border-t border-line px-3 py-1">{items.map((it) => <ToolRow key={it.id} it={it} />)}</div>}
    </div>
  );
}

function Transcript({ log }: { log: LogItem[] }) {
  const blocks = toBlocks(log);
  if (log.length === 0) return <p className="text-[13.5px] text-pebble">Waiting for this agent to start…</p>;
  return (
    <div className="space-y-3.5">
      {blocks.map((b, i) =>
        b.kind === "text" ? <Markdown key={i}>{b.text}</Markdown> : <ToolGroup key={i} items={b.items} />,
      )}
    </div>
  );
}

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
}

function statusDot(s: string) {
  return s === "running" ? "bg-electric-indigo nx-pulse" : s === "error" ? "bg-alarm-red" : "bg-lichen-green";
}

export function Orchestrator() {
  const { started, running, task, threads, selected, runs, setSelected, start, openRun, newRun } = useOrch();
  const [input, setInput] = useState("");

  if (!started) {
    return (
      <div className="scroll-thin flex h-full min-w-0 flex-1 flex-col items-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-[560px] text-center">
          <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-mist-lavender text-electric-indigo">
            <Users className="size-5" />
          </span>
          <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em] text-charcoal">Give the lead a big task</h2>
          <p className="mt-1.5 text-[14px] text-bark-grey">The lead splits it into sub-agents that run in parallel in this project.</p>
          <div className="mt-5 flex items-end gap-2 rounded-2xl border border-line-strong bg-paper-white p-2 text-left">
            <Textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(input); } }}
              placeholder="e.g. Add a login page with JWT auth"
              className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-[15px] shadow-none focus-visible:ring-0"
            />
            <Button size="icon" className="rounded-xl" disabled={!input.trim()} onClick={() => start(input)}><ArrowUp className="size-4" /></Button>
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => start(s)} className="rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal">{s}</button>
            ))}
          </div>
        </div>

        {/* recent runs — every run is kept and can be reopened to watch its progress */}
        {runs.length > 0 && (
          <div className="mt-10 w-full max-w-[560px] text-left">
            <p className="label mb-3 flex items-center gap-1.5"><History className="size-3.5" /> Recent runs</p>
            <div className="space-y-2">
              {runs.map((r) => (
                <button key={r.id} onClick={() => openRun(r.id)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-paper-white px-3.5 py-3 text-left transition-colors hover:border-line-strong">
                  <span className={`size-[7px] shrink-0 rounded-full ${statusDot(r.status)}`} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-charcoal">{r.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-pebble">
                    {r.status === "running" ? "running" : ago(r.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const lead = threads.find((t) => t.id === "lead");
  const subs = threads.filter((t) => t.id !== "lead");
  const sel = threads.find((t) => t.id === selected) ?? lead!;
  const selPP = sel.id === "lead" ? LEAD_PP : agentPP(subs.findIndex((t) => t.id === sel.id) + 1);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-6">
        <h1 className="truncate text-[15px] font-medium text-charcoal">{task}</h1>
        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[12px] text-bark-grey">
            {running && <Loader2 className="size-3.5 animate-spin text-electric-indigo" />}
            <span className={`size-[6px] rounded-full ${running ? "bg-electric-indigo nx-pulse" : "bg-lichen-green"}`} />
            {running ? `${subs.length ? subs.length + " agents" : "planning"}` : "done"}
          </span>
          <Button variant="outline" size="sm" className="gap-1.5 rounded-lg" onClick={newRun}>
            <Plus className="size-3.5" /> New run
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left rail — the delegation tree (who's doing what) */}
        <aside className="scroll-thin flex w-[336px] shrink-0 flex-col overflow-y-auto border-r border-line bg-warm-bone px-3 py-4">
          <p className="label mb-2.5 flex items-center gap-1.5 px-1">
            <GitBranch className="size-3.5" /> {subs.length ? `Delegated · ${subs.length} specialist${subs.length > 1 ? "s" : ""}` : "Workstream"}
          </p>
          <div className="space-y-2">
            {lead && <Row t={lead} lead pp={LEAD_PP} selected={selected === "lead"} onSelect={() => setSelected("lead")} />}
            {subs.length > 0 && (
              <div className="ml-3 space-y-2 border-l border-line pl-3">
                {subs.map((t, i) => (
                  <Row key={t.id} t={t} pp={agentPP(i + 1)} selected={selected === t.id} onSelect={() => setSelected(t.id)} />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* main — the selected agent's transcript, wide & readable */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-6">
            <img src={selPP} alt={sel.name} className="size-6 rounded-lg object-cover" />
            <span className="text-[13.5px] font-medium text-charcoal">{sel.name}</span>
            {sel.id === "lead" && <span className="label !text-[9px]">Lead</span>}
            <span className="flex items-center gap-1.5 text-[12px] text-bark-grey">
              <span className={`size-[6px] rounded-full ${dotClass(sel.status)}`} /> {sel.status}
            </span>
            <span className="ml-auto truncate font-mono text-[11px] text-pebble">{sel.scope}</span>
          </div>
          <div className="scroll-thin flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[760px] px-8 py-7">
              <Transcript log={sel.log} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
