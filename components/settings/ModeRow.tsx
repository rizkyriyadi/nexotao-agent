"use client";

import { useEffect, useState } from "react";
// From `agent-mode`, not `execution-policy`: the latter reaches the database,
// and importing it here put `node:fs` in the client bundle and broke the build.
import { AGENT_MODES, DEFAULT_MODE, type AgentMode } from "@/lib/agent-mode";

const LABEL: Record<AgentMode, string> = { agent: "Agent", plan: "Plan", ask: "Ask" };

/** The mode a new run starts in — the one execution setting that is real.
 *
 *  It replaces three switches that were wired to nothing. This one reads and
 *  writes `defaultMode` through /api/config, which is the value `modeToPolicy`
 *  actually consults when a run decides whether a tool may execute. */
export function ModeRow() {
  const [mode, setMode] = useState<AgentMode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((config) => { if (!cancelled) setMode(config.defaultMode ?? DEFAULT_MODE); })
      .catch(() => { if (!cancelled) setMode(DEFAULT_MODE); });
    return () => { cancelled = true; };
  }, []);

  const choose = async (next: AgentMode) => {
    setBusy(true);
    setMode(next);
    await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultMode: next }),
    }).catch(() => {});
    setBusy(false);
  };

  if (!mode) return <span className="font-mono text-[13px] text-pebble">—</span>;
  return (
    <div className="flex items-center gap-1 rounded-full border border-line bg-veil p-0.5">
      {AGENT_MODES.map((value) => (
        <button
          key={value} type="button" disabled={busy} onClick={() => void choose(value)}
          aria-pressed={mode === value}
          className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
            mode === value ? "bg-paper-white text-charcoal shadow-sm" : "text-bark-grey hover:text-charcoal"
          }`}
        >
          {LABEL[value]}
        </button>
      ))}
    </div>
  );
}
