"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "../ui/markdown";

// A single rendered line in a run transcript.
export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; target: string; status: "running" | "done" | "error"; display?: string; input?: unknown; output?: string }
  | { kind: "event"; tone: "neutral" | "success" | "error"; label: string; detail?: string };

export const TOOL_LABEL: Record<string, string> = {
  list_dir: "List", read_file: "Read", write_file: "Write", edit_file: "Edit",
  bash: "Run", grep: "Grep", web_search: "Search", web_fetch: "Fetch",
};

export const STATUS_LABEL: Record<string, string> = {
  in_progress: "running", in_review: "in review", todo: "queued", blocked: "waiting",
  done: "done", error: "error", cancelled: "cancelled", backlog: "backlog",
};

export function statusDot(s: string) {
  if (s === "in_progress") return "bg-electric-indigo nx-pulse";
  if (s === "done") return "bg-lichen-green";
  if (s === "in_review") return "bg-sapphire-link";
  if (s === "error" || s === "cancelled") return "bg-alarm-red";
  return "bg-pebble"; // todo / blocked / backlog
}

export function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ── transcript (grouped tool accordions + markdown) ───────────── */
type ToolItem = Extract<LogItem, { kind: "tool" }>;
type EventItem = Extract<LogItem, { kind: "event" }>;
type Block = { kind: "text"; text: string } | { kind: "tools"; items: ToolItem[] } | EventItem;

function toBlocks(log: LogItem[]): Block[] {
  const blocks: Block[] = [];
  for (const it of log) {
    if (it.kind === "text") { blocks.push({ kind: "text", text: it.text }); continue; }
    if (it.kind === "event") { blocks.push(it); continue; }
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
    <div className="py-[5px]">
      <div className="flex items-center gap-3">
        <span className={`size-[6px] shrink-0 rounded-full ${toolDot(it.status)}`} />
        <span className="w-14 shrink-0 text-[12.5px] font-medium text-charcoal">{TOOL_LABEL[it.name] ?? it.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-bark-grey">{it.target}</span>
        <span className="shrink-0 font-mono text-[11px] text-pebble">{it.status === "running" ? "…" : it.display ?? it.status}</span>
      </div>
      {(it.input !== undefined || it.output) && (
        <details className="ml-9 mt-1 text-[11px] text-pebble">
          <summary className="cursor-pointer select-none">Payload</summary>
          <pre className="scroll-thin mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-warm-bone p-2 font-mono text-[10.5px] text-bark-grey">
            {it.input !== undefined ? JSON.stringify(it.input, null, 2) : ""}{it.output ? `\n${it.output}` : ""}
          </pre>
        </details>
      )}
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

function EventCard({ event }: { event: EventItem }) {
  const dot = event.tone === "success" ? "bg-lichen-green" : event.tone === "error" ? "bg-alarm-red" : "bg-sapphire-link";
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-paper-white px-3 py-2 text-[12px]">
      <span className={`size-[6px] shrink-0 rounded-full ${dot}`} /><span className="font-medium text-charcoal">{event.label}</span>
      {event.detail && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-pebble">{event.detail}</span>}
    </div>
  );
}

export function Transcript({ log, waiting }: { log: LogItem[]; waiting: string }) {
  const blocks = toBlocks(log);
  if (log.length === 0) return <p className="text-[13.5px] text-pebble">{waiting}</p>;
  return (
    <div className="space-y-3.5">
      {blocks.map((block, index) => block.kind === "text"
        ? <Markdown key={index}>{block.text}</Markdown>
        : block.kind === "tools" ? <ToolGroup key={index} items={block.items} />
        : <EventCard key={index} event={block} />)}
    </div>
  );
}
