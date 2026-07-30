"use client";

import { useMemo, useState } from "react";
import { Check, ChevronRight, CircleSlash, Clock, Flag, GitBranch, PauseCircle, TriangleAlert } from "lucide-react";
import { Markdown } from "../ui/markdown";
import { ActivityIndicator } from "./ActivityIndicator";
import { ToolCall } from "./ToolCall";
import { presentationFor, toolInput } from "./tool-config";

// A single rendered line in a run transcript.
// NOTE: consumed by use-run-stream.ts — coordinate before changing this shape.
export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; target: string; status: "running" | "done" | "error"; display?: string; input?: unknown; output?: string }
  | { kind: "event"; tone: "neutral" | "success" | "error"; label: string; detail?: string }
  // The agent's closing report — the one block that tells the user what happened.
  | { kind: "summary"; text: string }
  // The run's commit could not be fast-forwarded into the user's branch, so the
  // work is sitting somewhere they have to be told about.
  | { kind: "integration"; branch: string; reason: string };

export type ToolItem = Extract<LogItem, { kind: "tool" }>;
type EventItem = Extract<LogItem, { kind: "event" }>;
type SummaryItem = Extract<LogItem, { kind: "summary" }>;
type IntegrationItem = Extract<LogItem, { kind: "integration" }>;

/** How the surrounding run is doing — drives which of the three end-of-run
 *  presentations the transcript shows. `queued` deliberately does NOT get the
 *  activity indicator: nothing is executing yet. */
export type RunPhase = "queued" | "running" | "settled";

export const TOOL_LABEL: Record<string, string> = {
  list_dir: "List", read_file: "Read", write_file: "Write", edit_file: "Edit",
  bash: "Run", grep: "Grep", web_search: "Search", web_fetch: "Fetch",
  graph_query: "Graph", graph_path: "Graph", graph_explain: "Graph",
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

/* ── blocking ────────────────────────────────────────────────── */

type Block =
  | { kind: "text"; text: string }
  | { kind: "tools"; items: ToolItem[] }
  | EventItem
  | SummaryItem
  | IntegrationItem;
/** Inside a tool block, consecutive calls to the SAME tool collapse together. */
type Run = { name: string; items: ToolItem[] };

function toBlocks(log: LogItem[]): Block[] {
  const blocks: Block[] = [];
  for (const it of log) {
    if (it.kind === "text") { blocks.push({ kind: "text", text: it.text }); continue; }
    if (it.kind === "event" || it.kind === "summary" || it.kind === "integration") { blocks.push(it); continue; }
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "tools") last.items.push(it);
    else blocks.push({ kind: "tools", items: [it] });
  }
  return blocks;
}

function toRuns(items: ToolItem[]): Run[] {
  const runs: Run[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last.name === item.name) last.items.push(item);
    else runs.push({ name: item.name, items: [item] });
  }
  return runs;
}

/* ── grouped tools ───────────────────────────────────────────── */

/** N calls to one tool, folded behind an x{n} badge and a preview of the first
 *  couple of targets — the pattern from claudecodeui's ToolGroupContainer. */
function ToolGroup({ run }: { run: Run }) {
  const spec = presentationFor(run.name);
  const active = run.items.some((i) => i.status === "running");
  const failed = run.items.some((i) => i.status === "error");
  const [open, setOpen] = useState(false);
  const Icon = spec.icon;

  const preview = useMemo(() => {
    const first = run.items.slice(0, 2).map((i) => spec.value(toolInput(i.input)) || i.target).filter(Boolean);
    const extra = run.items.length - first.length;
    const text = first.join(", ");
    if (!text) return extra > 0 ? `+${extra} more` : "";
    return extra > 0 ? `${text}, +${extra} more` : text;
  }, [run.items, spec]);

  // Expanded rows sit dense: the group header already carries the tool identity.
  return (
    <div className={`border-l-2 ${spec.accent}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-1 pl-2.5 text-left"
      >
        <ChevronRight className={`size-3 shrink-0 text-pebble transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon className={`size-3.5 shrink-0 ${spec.iconTint}`} />
        <span className="shrink-0 text-[11.5px] font-medium text-bark-grey">{spec.label}</span>
        <span className={`shrink-0 rounded-md px-1.5 py-px text-[10px] font-medium ${
          active ? "bg-electric-indigo/10 text-electric-indigo" : failed ? "bg-alarm-red/10 text-alarm-red" : "bg-veil text-bark-grey"
        }`}>
          ×{run.items.length}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-pebble" title={preview}>{preview}</span>
        {active && <span className="size-1.5 shrink-0 rounded-full bg-electric-indigo nx-pulse" />}
      </button>
      {open && (
        <div className="ml-2.5 border-l border-line pl-1.5">
          {run.items.map((item) => <ToolCall key={item.id} item={item} dense />)}
        </div>
      )}
    </div>
  );
}

/** A contiguous stretch of tool activity, boxed so it reads as one "the agent
 *  went and did things" beat between paragraphs of prose. */
function ToolBlock({ items }: { items: ToolItem[] }) {
  const runs = toRuns(items);
  return (
    <div className="space-y-0.5 rounded-xl border border-line bg-paper-white/70 px-2 py-1.5">
      {runs.map((run, index) =>
        run.items.length > 1
          ? <ToolGroup key={`${run.name}-${index}`} run={run} />
          : <ToolCall key={run.items[0].id} item={run.items[0]} />
      )}
    </div>
  );
}

/* ── closing report ──────────────────────────────────────────── */

/** The agent's report back to the user, written after the work in a turn of its
 *  own. Set apart from the running commentary above it because it is the part
 *  the user actually came for — previously there was no such block at all, and a
 *  run just stopped mid-thought. */
function SummaryBlock({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-electric-indigo/25 bg-mist-lavender/30 px-3.5 py-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-electric-indigo">
        <Flag className="size-3" /> Result
      </p>
      <div className="text-[13.5px] leading-relaxed text-charcoal"><Markdown>{text}</Markdown></div>
    </div>
  );
}

/* ── unintegrated work ───────────────────────────────────────── */

/** The agent finished, but its commit could not be fast-forwarded into the
 *  branch the user works on — their folder looks untouched. Without this block
 *  the run reads as "done" and the work is invisible: it lives on a branch no
 *  other screen in the app names. Deliberately not styled as an error; nothing
 *  broke, and refusing to merge is what kept the user's own edits safe. */
function IntegrationBlock({ item }: { item: IntegrationItem }) {
  return (
    <div className="rounded-xl border border-amber/40 bg-amber/[0.07] px-3.5 py-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-bark-grey">
        <GitBranch className="size-3" /> Your project folder was left as it is
      </p>
      <p className="text-[13px] leading-relaxed text-charcoal">{item.reason}.</p>
      <p className="mt-2 text-[12.5px] text-bark-grey">Bring the work in with:</p>
      <code className="mt-1 block overflow-x-auto rounded-lg bg-veil px-2 py-1.5 font-mono text-[11.5px] text-charcoal">
        git merge {item.branch}
      </code>
    </div>
  );
}

/* ── terminal state ──────────────────────────────────────────── */

const TERMINAL: Record<string, { icon: typeof Check; className: string }> = {
  success: { icon: Check, className: "border-lichen-green/30 bg-lichen-green/[0.07] text-lichen-green" },
  error: { icon: TriangleAlert, className: "border-alarm-red/30 bg-alarm-red/[0.06] text-alarm-red" },
  neutral: { icon: CircleSlash, className: "border-line-strong bg-veil text-bark-grey" },
};

/** Done / Paused / Cancelled / Failed chip that closes out a run section.
 *  Cancellations arrive with tone `error` from the stream but read as neutral,
 *  not a fault; "Paused" (out of steps) is neutral too — nothing broke, the work
 *  simply is not finished. */
function TerminalChip({ event }: { event: EventItem }) {
  const cancelled = /cancel/i.test(event.label);
  const paused = /paused/i.test(event.label);
  const spec = TERMINAL[cancelled || paused ? "neutral" : event.tone] ?? TERMINAL.neutral;
  const Icon = paused ? PauseCircle : cancelled ? CircleSlash : spec.icon;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${spec.className}`}>
        <Icon className="size-3" /> {event.label}
      </span>
      {event.detail && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-pebble" title={event.detail}>{event.detail}</span>}
    </div>
  );
}

/** Non-terminal notices (e.g. "Waiting — approval required"). */
function EventNote({ event }: { event: EventItem }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-warm-bone px-2.5 py-1.5 text-[12px]">
      <Clock className="size-3 shrink-0 text-pebble" />
      <span className="font-medium text-charcoal">{event.label}</span>
      {event.detail && <span className="min-w-0 flex-1 truncate text-[11.5px] text-bark-grey">{event.detail}</span>}
    </div>
  );
}

const TERMINAL_LABELS = new Set(["Done", "Failed", "Cancelled", "Ended", "Paused"]);

/* ── transcript ──────────────────────────────────────────────── */

/** Map a persisted run status onto the chip we'd have shown had the stream
 *  delivered a terminal event. Used when a run finished before the client
 *  connected, or when the stream closed without a final frame. */
function chipForStatus(status: string): EventItem {
  // The ledger's vocabulary (HeartbeatStatus) is succeeded/failed/cancelled;
  // "done"/"error" are the stream's names for the same three. Accept both, and
  // never return null: a settled section with no chip renders as an empty
  // bubble, which is precisely the "is it still running?" ambiguity being fixed.
  if (status === "succeeded" || status === "done") return { kind: "event", tone: "success", label: "Done" };
  if (status === "in_review") return { kind: "event", tone: "neutral", label: "Paused", detail: "Needs your review before it continues" };
  if (status === "cancelled") return { kind: "event", tone: "error", label: "Cancelled" };
  if (status === "failed" || status === "error") return { kind: "event", tone: "error", label: "Failed" };
  // queued/running/waiting reaching here means the run ended without ever
  // reporting how — stale, not successful.
  return { kind: "event", tone: "neutral", label: "Ended", detail: `No result recorded (${status || "unknown"})` };
}

export function Transcript({
  log, phase, status, startedAt, onStop, stopping,
}: {
  log: LogItem[];
  phase: RunPhase;
  /** Persisted run status, used to settle the section when the stream is silent. */
  status?: string;
  /** Epoch ms the run began — drives the elapsed clock. */
  startedAt?: number | null;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const blocks = useMemo(() => toBlocks(log), [log]);

  if (log.length === 0 && phase === "queued") {
    return (
      <p className="flex items-center gap-2 text-[13px] text-pebble">
        <Clock className="size-3.5" /> Queued — Hutao will start shortly…
      </p>
    );
  }

  // A run can settle without the stream ever emitting a terminal frame (cancelled
  // mid-flight, replayed after the fact). Never leave a section open-ended.
  const streamedTerminal = blocks.some((b) => b.kind === "event" && TERMINAL_LABELS.has(b.label));
  const fallbackChip = phase === "settled" && !streamedTerminal ? chipForStatus(status ?? "") : null;
  // A settled run that produced no transcript at all still owes the user a
  // sentence: an avatar next to an empty bubble reads as "stuck", not "finished".
  const empty = blocks.length === 0;

  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        if (block.kind === "text") return <Markdown key={index}>{block.text}</Markdown>;
        if (block.kind === "tools") return <ToolBlock key={index} items={block.items} />;
        if (block.kind === "summary") return <SummaryBlock key={index} text={block.text} />;
        if (block.kind === "integration") return <IntegrationBlock key={index} item={block} />;
        return TERMINAL_LABELS.has(block.label)
          ? <TerminalChip key={index} event={block} />
          : <EventNote key={index} event={block} />;
      })}

      {phase === "running" && (
        <ActivityIndicator log={log} startedAt={startedAt ?? null} onStop={onStop} stopping={stopping} />
      )}
      {fallbackChip && <TerminalChip event={fallbackChip} />}
      {empty && phase === "settled" && (
        <p className="text-[12.5px] text-pebble">This run ended without producing a transcript.</p>
      )}
    </div>
  );
}
