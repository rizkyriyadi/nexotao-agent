"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowUpRight, ChevronDown } from "lucide-react";
import { summarizeRuns, type RunSummary } from "@/lib/runs";

/**
 * Always-visible indicator of runs that are currently executing.
 *
 * Mounted once in the app shell so it follows the user across every page. It
 * answers the "where is the run that's running?" question at a glance and jumps
 * straight to the live transcript of the executing node.
 */
export function ActiveRunIndicator() {
  const router = useRouter();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const d = await fetch("/api/issues").then((r) => r.json());
        if (!alive) return;
        setRuns(summarizeRuns(d.issues ?? []).filter((r) => r.active));
      } catch {
        /* keep last known state */
      }
    };
    poll();
    timer.current = setInterval(poll, 3000);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  if (runs.length === 0) return null;

  const jump = (run: RunSummary) => {
    setExpanded(false);
    router.push(`/board?goal=${run.rootId}&node=${run.liveNodeId}`);
  };

  const top = runs[0];
  const rest = runs.slice(1);
  const label = (run: RunSummary) =>
    run.runningCount > 0
      ? `${run.runningCount} agent${run.runningCount > 1 ? "s" : ""} working`
      : run.taskCount > 0
        ? `${run.taskCount} task${run.taskCount > 1 ? "s" : ""} queued`
        : "planning";

  return (
    <div className="fixed bottom-5 left-[86px] z-30 flex flex-col gap-2" aria-live="polite">
      {expanded &&
        rest.map((run) => (
          <button
            key={run.rootId}
            onClick={() => jump(run)}
            className="flex max-w-[320px] items-center gap-2.5 rounded-2xl border border-line bg-paper-white px-3.5 py-2 text-left shadow-float transition-colors hover:border-line-strong"
          >
            <span className="size-[7px] shrink-0 rounded-full bg-electric-indigo nx-pulse" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal">{run.title}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-pebble">{label(run)}</span>
            <ArrowUpRight className="size-3.5 shrink-0 text-pebble" />
          </button>
        ))}

      <div className="flex max-w-[360px] items-center gap-2.5 rounded-2xl border border-electric-indigo/30 bg-paper-white py-2 pl-3.5 pr-2 shadow-float">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-electric-indigo" />
        <button onClick={() => jump(top)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title="Jump to live transcript">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-charcoal">{top.title}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-pebble">{label(top)}</span>
          <ArrowUpRight className="size-3.5 shrink-0 text-electric-indigo" />
        </button>
        {rest.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse active runs" : `Show ${rest.length} more active run${rest.length > 1 ? "s" : ""}`}
            className="flex shrink-0 items-center gap-1 rounded-full bg-electric-indigo/10 px-2 py-1 text-[11px] font-medium text-electric-indigo transition-colors hover:bg-electric-indigo/15"
          >
            +{rest.length}
            <ChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
    </div>
  );
}
