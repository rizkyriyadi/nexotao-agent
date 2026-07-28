"use client";

import { useEffect, useState } from "react";
import { Square } from "lucide-react";
import { presentationFor, toolInput } from "./tool-config";
import type { LogItem } from "./transcript";

// Cycled only when nothing concrete is in flight — a real tool label always wins.
const GENERIC = ["Thinking", "Working", "Reasoning", "Composing"];

/** What the agent is doing right now, in words. Reads the most recent still-running
 *  tool call and turns it into a sentence ("Running npm test", "Reading agent.ts");
 *  falls back to a slowly-rotating generic verb between tool calls. */
export function describeActivity(log: LogItem[], elapsedSeconds: number): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const item = log[i];
    if (item.kind !== "tool") continue;
    if (item.status !== "running") break; // newest tool already finished — model is thinking
    return presentationFor(item.name).verb(toolInput(item.input));
  }
  return GENERIC[Math.floor(elapsedSeconds / 4) % GENERIC.length];
}

function elapsedLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Inline "what's happening" line, in the spirit of Claude Code's status row: a
 * pulsing dot, a shimmering label naming the current action, ticking elapsed
 * time, and an inline Stop. Only rendered while a run is genuinely streaming.
 */
export function ActivityIndicator({
  log, startedAt, onStop, stopping,
}: {
  log: LogItem[];
  /** Epoch ms the run began. Null when the backend hasn't stamped one yet — the
   *  clock then counts from first paint, which is stable across re-renders. */
  startedAt: number | null;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [mountedAt] = useState(() => Date.now());
  const origin = startedAt ?? mountedAt;
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - origin) / 1000)));

  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [origin]);

  const label = describeActivity(log, elapsed);

  return (
    <div className="mt-2.5 flex items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-electric-indigo/25 bg-mist-lavender/50 px-2.5 py-1">
        <span className="size-1.5 shrink-0 rounded-full bg-electric-indigo nx-pulse" aria-hidden />
        <span className="nx-shimmer min-w-0 truncate text-[12px] font-medium">{label}…</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-pebble">{elapsedLabel(elapsed)}</span>
      </div>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-paper-white px-2 py-1 text-[11.5px] text-bark-grey transition-colors hover:border-alarm-red/40 hover:text-alarm-red disabled:opacity-50"
        >
          <Square className="size-2.5 fill-current" />
          {stopping ? "Stopping…" : "Stop"}
        </button>
      )}
    </div>
  );
}
