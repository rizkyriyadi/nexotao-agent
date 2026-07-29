"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { diffStat, lineDiff } from "./line-diff";
import { basename, presentationFor, toolInput } from "./tool-config";
import { CopyButton, deriveToolStatus, ToolStatusBadge } from "./tool-atoms";
import type { ToolItem } from "./transcript";

const OUTPUT_CAP = 4_000; // enough to read; short enough not to wedge the DOM

/** One tool call: a one-line header that always reads as a sentence, plus an
 *  optional expandable body rendered per tool kind (terminal, diff, list, text).
 *  Replaces the old "grey row + raw JSON payload" treatment. */
export function ToolCall({ item, dense = false }: { item: ToolItem; dense?: boolean }) {
  const spec = presentationFor(item.name);
  const input = toolInput(item.input);
  const status = deriveToolStatus(item.status, item.output);
  const value = spec.value(input) || item.target || "—";
  // Diff/write bodies are built from the *input*, so they exist as soon as the
  // call settles; everything else needs output to have arrived.
  const settled = item.status !== "running";
  const hasBody = spec.body === "none" ? false
    : spec.body === "diff" || spec.body === "write" ? settled
    : Boolean(item.output);
  const [open, setOpen] = useState(false);
  const Icon = spec.icon;

  // Terminal calls get their own shape: the command lives in a dark pill so it
  // reads as a shell line rather than a label/value pair.
  if (spec.body === "terminal") {
    return (
      <div className={`group border-l-2 ${spec.accent} pl-2.5 ${dense ? "py-1" : "py-1.5"}`}>
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => hasBody && setOpen((v) => !v)}
            disabled={!hasBody}
            className="min-w-0 flex-1 rounded-lg bg-terminal px-2.5 py-1.5 text-left disabled:cursor-default"
          >
            <code className="block break-all font-mono text-[12px] leading-[1.5] text-terminal-text">
              <span className="select-none text-terminal-dim">$ </span>{value}
            </code>
          </button>
          <div className="flex shrink-0 items-center gap-1 pt-1">
            <ToolStatusBadge status={status} />
            <CopyButton text={value} label="Copy command" className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
          </div>
        </div>
        {item.display && status !== "running" && (
          <p className="mt-1 font-mono text-[10.5px] text-pebble">{item.display}</p>
        )}
        {open && item.output && <OutputBlock text={item.output} tone={status === "error" ? "error" : "plain"} />}
      </div>
    );
  }

  return (
    <div className={`group border-l-2 ${spec.accent} pl-2.5 ${dense ? "py-[3px]" : "py-1"}`}>
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
      >
        {hasBody ? (
          <ChevronRight className={`size-3 shrink-0 text-pebble transition-transform ${open ? "rotate-90" : ""}`} />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <Icon className={`size-3.5 shrink-0 ${spec.iconTint}`} />
        <span className="shrink-0 text-[11.5px] font-medium text-bark-grey">{spec.label}</span>
        <ValueLabel value={value} mono={spec.mono} emphasiseBasename={spec.mono && value.includes("/")} />
        {item.display && status !== "running" && (
          <span className="shrink-0 font-mono text-[10.5px] text-pebble">{item.display}</span>
        )}
        <ToolStatusBadge status={status} />
      </button>
      {open && <ToolBody item={item} status={status} />}
    </div>
  );
}

/** File paths read better with the directory de-emphasised and the filename
 *  carrying the weight — the same trick claudecodeui uses on Read/Edit rows. */
function ValueLabel({ value, mono, emphasiseBasename }: { value: string; mono?: boolean; emphasiseBasename?: boolean }) {
  const face = mono ? "font-mono text-[11.5px]" : "text-[12px]";
  if (!emphasiseBasename) {
    return <span className={`min-w-0 flex-1 truncate ${face} text-charcoal`} title={value}>{value}</span>;
  }
  const name = basename(value);
  const dir = value.slice(0, value.length - name.length);
  return (
    <span className={`min-w-0 flex-1 truncate ${face}`} title={value}>
      <span className="text-pebble">{dir}</span>
      <span className="text-charcoal underline decoration-line-strong underline-offset-2">{name}</span>
    </span>
  );
}

/* ── bodies ──────────────────────────────────────────────────── */

function ToolBody({ item, status }: { item: ToolItem; status: ReturnType<typeof deriveToolStatus> }) {
  const spec = presentationFor(item.name);
  const input = toolInput(item.input);

  if (spec.body === "diff" && status !== "running") {
    return <DiffBlock path={String(input.path ?? "")} oldText={String(input.old_str ?? "")} newText={String(input.new_str ?? "")} />;
  }
  if (spec.body === "write" && status !== "running") {
    return <WriteBlock path={String(input.path ?? "")} content={String(input.content ?? "")} />;
  }
  if (!item.output) return null;
  if (spec.body === "list") return <ListBlock text={item.output} />;
  return <OutputBlock text={item.output} tone={status === "error" ? "error" : "plain"} />;
}

function OutputBlock({ text, tone }: { text: string; tone: "plain" | "error" }) {
  const capped = text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n… (truncated)` : text;
  return (
    <div className="relative mt-1.5 ml-5">
      <pre className={`scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-2.5 font-mono text-[11px] leading-[1.55] ${
        tone === "error" ? "border-alarm-red/25 bg-alarm-red/[0.04] text-alarm-red" : "border-line bg-code-surface text-bark-grey"
      }`}>
        {capped}
      </pre>
      <CopyButton text={text} className="absolute right-1.5 top-1.5 bg-paper-white/80 opacity-0 group-hover:opacity-100 focus:opacity-100" label="Copy output" />
    </div>
  );
}

/** list_dir / grep output is line-oriented; showing it as rows instead of a blob
 *  makes the count scannable and keeps long results from swallowing the page. */
function ListBlock({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n").filter(Boolean), [text]);
  const shown = lines.slice(0, 40);
  return (
    <div className="mt-1.5 ml-5 rounded-lg border border-line bg-code-surface p-2">
      <div className="scroll-thin max-h-64 overflow-auto">
        {shown.map((line, index) => (
          <div key={index} className="truncate font-mono text-[11px] leading-[1.6] text-bark-grey" title={line}>{line}</div>
        ))}
      </div>
      {lines.length > shown.length && (
        <p className="mt-1 font-mono text-[10.5px] text-pebble">+{lines.length - shown.length} more</p>
      )}
    </div>
  );
}

function DiffBlock({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const lines = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  const { added, removed } = useMemo(() => diffStat(lines), [lines]);
  if (lines.length === 0) return null;
  return (
    <div className="mt-1.5 ml-5 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-code-surface px-2.5 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-bark-grey" title={path}>{path}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-lichen-green">+{added}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-alarm-red">−{removed}</span>
      </div>
      <div className="scroll-thin max-h-72 overflow-auto bg-paper-white font-mono text-[11px] leading-[1.65]">
        {lines.map((line, index) => (
          <div key={index} className={`flex ${line.type === "add" ? "diff-add" : line.type === "del" ? "diff-del" : ""}`}>
            <span className="w-9 shrink-0 select-none pr-1.5 text-right text-pebble">{line.newNo ?? line.oldNo ?? ""}</span>
            <span className={`w-3 shrink-0 select-none ${line.type === "add" ? "text-lichen-green" : line.type === "del" ? "text-alarm-red" : "text-pebble"}`}>
              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-all pr-2 text-charcoal">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A fresh write has no "before", so show the head of the new file rather than a
 *  diff against nothing. */
function WriteBlock({ path, content }: { path: string; content: string }) {
  const lines = content.split("\n");
  const shown = lines.slice(0, 30);
  if (!content) return null;
  return (
    <div className="group/write relative mt-1.5 ml-5 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-code-surface px-2.5 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-bark-grey" title={path}>{path}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-lichen-green">+{lines.length}</span>
        <CopyButton text={content} label="Copy file contents" />
      </div>
      <div className="scroll-thin max-h-72 overflow-auto bg-paper-white font-mono text-[11px] leading-[1.65]">
        {shown.map((line, index) => (
          <div key={index} className="flex">
            <span className="w-9 shrink-0 select-none pr-1.5 text-right text-pebble">{index + 1}</span>
            <span className="flex-1 whitespace-pre-wrap break-all pr-2 text-charcoal">{line || " "}</span>
          </div>
        ))}
      </div>
      {lines.length > shown.length && (
        <p className="border-t border-line bg-code-surface px-2.5 py-1 font-mono text-[10.5px] text-pebble">
          +{lines.length - shown.length} more lines
        </p>
      )}
    </div>
  );
}
