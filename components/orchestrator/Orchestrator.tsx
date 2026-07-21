"use client";

import { useState } from "react";
import { Crown, Users, ArrowUp, History, Plus, Loader2, ChevronRight, GitBranch } from "lucide-react";
import { useOrch, type IssueNode, type LogItem } from "./orchestrator-context";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { agentPP, LEAD_PP } from "@/lib/avatars";
import { Markdown } from "../ui/markdown";

const TOOL_LABEL: Record<string, string> = {
  list_dir: "List", read_file: "Read", write_file: "Write", edit_file: "Edit",
  bash: "Run", grep: "Grep", delegate: "Delegate", web_search: "Search", web_fetch: "Fetch",
};

const SUGGESTIONS = [
  "Add a login page with JWT auth",
  "Build a REST API for todos with tests",
  "Add dark mode across the app",
];

const STATUS_LABEL: Record<string, string> = {
  in_progress: "running", in_review: "in review", todo: "queued", blocked: "waiting", done: "done", error: "error", cancelled: "cancelled", backlog: "backlog",
};
function statusDot(s: string) {
  if (s === "in_progress") return "bg-electric-indigo nx-pulse";
  if (s === "done") return "bg-lichen-green";
  if (s === "in_review") return "bg-sapphire-link";
  if (s === "error" || s === "cancelled") return "bg-alarm-red";
  return "bg-pebble"; // todo / blocked / backlog
}

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
}

/* ── transcript (grouped tool accordions + markdown) ───────────── */
type ToolItem = Extract<LogItem, { kind: "tool" }>;
type Block = { kind: "text"; text: string } | { kind: "tools"; items: ToolItem[] };
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
      <span className="w-14 shrink-0 text-[12.5px] font-medium text-charcoal">{TOOL_LABEL[it.name] ?? it.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-bark-grey">{it.target}</span>
      <span className="shrink-0 font-mono text-[11px] text-pebble">{it.status === "running" ? "…" : it.display ?? it.status}</span>
    </div>
  );
}
function ToolGroup({ items }: { items: ToolItem[] }) {
  const running = items.some((i) => i.status === "running");
  const [open, setOpen] = useState(items.length <= 2 || running);
  if (items.length === 1) return <div className="rounded-lg border border-line bg-paper-white px-3"><ToolRow it={items[0]} /></div>;
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
function Transcript({ log, waiting }: { log: LogItem[]; waiting: string }) {
  const blocks = toBlocks(log);
  if (log.length === 0) return <p className="text-[13.5px] text-pebble">{waiting}</p>;
  return (
    <div className="space-y-3.5">
      {blocks.map((b, i) => (b.kind === "text" ? <Markdown key={i}>{b.text}</Markdown> : <ToolGroup key={i} items={b.items} />))}
    </div>
  );
}

/* ── tree row ──────────────────────────────────────────────────── */
function Row({ node, pp, lead, selected, onSelect, depNames }: { node: IssueNode; pp: string; lead?: boolean; selected: boolean; onSelect: () => void; depNames: string[] }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${selected ? "border-electric-indigo bg-electric-indigo/[0.04]" : "border-line hover:border-line-strong"}`}
    >
      <span className="relative mt-0.5 block size-8 shrink-0">
        <img src={pp} alt={node.agentName} className="size-8 rounded-xl object-cover" />
        {lead && <Crown className="absolute -left-1 -top-1 size-3.5 rounded-full bg-warm-bone p-[1px] text-electric-indigo" />}
        <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-warm-bone ${statusDot(node.status)}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-charcoal">{node.agentName}</span>
          {lead && <span className="label !text-[9px]">Lead</span>}
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-pebble">{STATUS_LABEL[node.status] ?? node.status}</span>
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-bark-grey">{node.title}</span>
        {depNames.length > 0 && <span className="mt-0.5 block font-mono text-[10.5px] text-pebble">waits on {depNames.join(", ")}</span>}
      </span>
    </button>
  );
}

export function Orchestrator() {
  const { started, running, goalText, nodes, selected, log, recent, approval, approve, setSelected, start, openRun, newRun } = useOrch();
  const [input, setInput] = useState("");

  if (!started) {
    return (
      <div className="scroll-thin flex h-full min-w-0 flex-1 flex-col items-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-[560px] text-center">
          <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-mist-lavender text-electric-indigo"><Users className="size-5" /></span>
          <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em] text-charcoal">Give the lead a goal</h2>
          <p className="mt-1.5 text-[14px] text-bark-grey">The lead breaks it into tasks, delegates to specialists, and integrates the result.</p>
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

        {recent.length > 0 && (
          <div className="mt-10 w-full max-w-[560px] text-left">
            <p className="label mb-3 flex items-center gap-1.5"><History className="size-3.5" /> Recent runs</p>
            <div className="space-y-2">
              {recent.map((r) => (
                <button key={r.id} onClick={() => openRun(r.id)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-paper-white px-3.5 py-3 text-left transition-colors hover:border-line-strong">
                  <span className={`size-[7px] shrink-0 rounded-full ${statusDot(r.status)}`} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-charcoal">{r.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-pebble">{r.status === "in_progress" ? "running" : ago(r.updatedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const root = nodes.find((n) => n.parentId === null);
  const children = nodes.filter((n) => n.parentId && n.parentId === root?.id);
  const sel = nodes.find((n) => n.id === selected) ?? root;
  const ppFor = (n: IssueNode) => (n.role === "lead" ? LEAD_PP : agentPP(children.findIndex((c) => c.id === n.id) + 1));
  const depNamesFor = (n: IssueNode) => n.blockedBy.map((bid) => nodes.find((x) => x.id === bid)?.agentName).filter(Boolean) as string[];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-6">
        <h1 className="truncate text-[15px] font-medium text-charcoal">{goalText}</h1>
        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[12px] text-bark-grey">
            {running && <Loader2 className="size-3.5 animate-spin text-electric-indigo" />}
            <span className={`size-[6px] rounded-full ${running ? "bg-electric-indigo nx-pulse" : "bg-lichen-green"}`} />
            {running ? `${children.length ? children.length + " tasks" : "planning"}` : "done"}
          </span>
          <Button variant="outline" size="sm" className="gap-1.5 rounded-lg" onClick={newRun}><Plus className="size-3.5" /> New run</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* delegation tree */}
        <aside className="scroll-thin flex w-[336px] shrink-0 flex-col overflow-y-auto border-r border-line bg-warm-bone px-3 py-4">
          <p className="label mb-2.5 flex items-center gap-1.5 px-1">
            <GitBranch className="size-3.5" /> {children.length ? `Delegated · ${children.length} task${children.length > 1 ? "s" : ""}` : "Workstream"}
          </p>
          <div className="space-y-2">
            {root && <Row node={root} pp={LEAD_PP} lead selected={selected === root.id} onSelect={() => setSelected(root.id)} depNames={[]} />}
            {children.length > 0 && (
              <div className="ml-3 space-y-2 border-l border-line pl-3">
                {children.map((n) => (
                  <Row key={n.id} node={n} pp={ppFor(n)} selected={selected === n.id} onSelect={() => setSelected(n.id)} depNames={depNamesFor(n)} />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* selected issue transcript */}
        <div className="flex min-w-0 flex-1 flex-col">
          {sel && (
            <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-6">
              <img src={ppFor(sel)} alt={sel.agentName} className="size-6 rounded-lg object-cover" />
              <span className="text-[13.5px] font-medium text-charcoal">{sel.agentName}</span>
              {sel.role === "lead" && <span className="label !text-[9px]">Lead</span>}
              <span className="flex items-center gap-1.5 text-[12px] text-bark-grey">
                <span className={`size-[6px] rounded-full ${statusDot(sel.status)}`} /> {STATUS_LABEL[sel.status] ?? sel.status}
              </span>
              <span className="ml-auto truncate font-mono text-[11px] text-pebble">{sel.ref} · {sel.title}</span>
            </div>
          )}
          <div className="scroll-thin flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[760px] px-8 py-7">
              {approval && (
                <div className="mb-4 rounded-xl border border-electric-indigo bg-electric-indigo/[0.04] p-4">
                  <p className="text-[13px] font-medium text-charcoal">Approve {TOOL_LABEL[approval.name] ?? approval.name}?</p>
                  <code className="mt-2 block break-words text-[12px] text-bark-grey">{approval.input?.command ?? approval.input?.path ?? approval.name}</code>
                  <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => approve("deny")}>Deny</Button><Button size="sm" onClick={() => approve("allow")}>Allow</Button></div>
                </div>
              )}
              <Transcript log={log} waiting={sel?.status === "blocked" ? "Waiting on its dependencies…" : sel?.status === "todo" ? "Queued — will start when ready…" : "Waiting for this agent to start…"} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
