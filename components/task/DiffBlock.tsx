"use client";

import { useMemo } from "react";
import { diffStat, lineDiff } from "./line-diff";

/** A before/after pair rendered as a unified diff.
 *
 *  Lives on its own rather than inside `ToolCall` because two very different
 *  callers want the same picture: an `edit_file` call mid-run, and the Changes
 *  panel showing what a whole run did to the folder. They differ only in where
 *  the box sits on the page, which is what `className` is for — the tool call
 *  indents under its header, the panel does not. */
export function DiffBlock({
  path, oldText, newText, className = "mt-1.5 ml-5",
}: {
  path: string;
  oldText: string;
  newText: string;
  className?: string;
}) {
  const lines = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  const { added, removed } = useMemo(() => diffStat(lines), [lines]);
  if (lines.length === 0) return null;
  return (
    <div className={`overflow-hidden rounded-lg border border-line ${className}`}>
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
