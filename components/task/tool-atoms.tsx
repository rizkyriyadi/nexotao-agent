"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/* ── status ──────────────────────────────────────────────────── */

export type ToolStatus = "running" | "completed" | "error" | "denied";

// The runtime reports a user-refused tool as a plain failure (lib/agent.ts
// substitutes this sentence for the tool output), so "denied" has to be read
// back out of the message rather than off a dedicated status.
const DENIAL_MARKERS = ["denied this action", "permission denied by user"];

/** Map a stream-level tool item onto the four states the UI distinguishes. */
export function deriveToolStatus(status: "running" | "done" | "error", output?: string): ToolStatus {
  if (status === "running") return "running";
  if (status === "done") return "completed";
  const text = (output ?? "").toLowerCase();
  return DENIAL_MARKERS.some((m) => text.includes(m)) ? "denied" : "error";
}

const BADGE: Record<ToolStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-electric-indigo/10 text-electric-indigo" },
  completed: { label: "Done", className: "bg-lichen-green/10 text-lichen-green" },
  error: { label: "Error", className: "bg-alarm-red/10 text-alarm-red" },
  denied: { label: "Denied", className: "bg-amber/12 text-amber" },
};

export function ToolStatusBadge({ status, className = "" }: { status: ToolStatus; className?: string }) {
  const spec = BADGE[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-[10px] font-medium ${spec.className} ${className}`}>
      {status === "running" && <span className="size-[5px] rounded-full bg-current nx-pulse" />}
      {spec.label}
    </span>
  );
}

/* ── copy ────────────────────────────────────────────────────── */

/** Copy-to-clipboard with a 2s confirmation. Falls back silently in insecure
 *  contexts where `navigator.clipboard` is unavailable. */
export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — nothing useful to say */ }
  }, [text]);

  return { copied, copy };
}

export function CopyButton({ text, className = "", label = "Copy" }: { text: string; className?: string; label?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      className={`shrink-0 rounded-md p-1 text-pebble transition-colors hover:bg-veil hover:text-charcoal ${className}`}
    >
      {copied ? <Check className="size-3 text-lichen-green" /> : <Copy className="size-3" />}
    </button>
  );
}
