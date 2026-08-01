"use client";

import { useEffect, useState } from "react";

type ReviewMode = "review" | "auto";

const MODES: ReviewMode[] = ["review", "auto"];
const LABEL: Record<ReviewMode, string> = { review: "Review", auto: "Auto" };

/** What happens after a run has written to the project folder.
 *
 *  Runs edit the user's files directly, so by the time this setting applies the
 *  changes are already on disk either way — this is not a gate on the work, it
 *  is a gate on the task. `review` parks it and holds the snapshot so Revert
 *  stays available until the user has looked; `auto` finishes the task and lets
 *  the snapshot age out on its own. The diff and the Revert button are there in
 *  both; only the waiting differs. */
export function ReviewModeRow() {
  const [mode, setMode] = useState<ReviewMode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((config) => { if (!cancelled) setMode(config.reviewMode === "auto" ? "auto" : "review"); })
      .catch(() => { if (!cancelled) setMode("review"); });
    return () => { cancelled = true; };
  }, []);

  const choose = async (next: ReviewMode) => {
    setBusy(true);
    setMode(next);
    await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewMode: next }),
    }).catch(() => {});
    setBusy(false);
  };

  if (!mode) return <span className="font-mono text-[13px] text-pebble">—</span>;
  return (
    <div className="flex items-center gap-1 rounded-full border border-line bg-veil p-0.5">
      {MODES.map((value) => (
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
