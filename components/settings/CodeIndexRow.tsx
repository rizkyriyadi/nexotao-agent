"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

/** Mirror of GET/POST /api/code-index/install. */
type InstallResponse = { ok?: boolean; available?: boolean; command?: string; error?: string };

/**
 * Install the optional code index, the thing that lets the agent's graph tools
 * answer from your code rather than from work history alone.
 *
 * Deliberately a button and not a boot-time step: the install pulls ~40 MB and
 * takes about a minute, so it happens when the user asks for it and at no other
 * time. The route requires `confirm: true` for the same reason.
 */
export function CodeIndexRow() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/code-index/install")
      .then((r) => r.json())
      .then((r: InstallResponse) => { setAvailable(!!r.available); setCommand(r.command ?? null); })
      .catch(() => setAvailable(false));
  }, []);

  async function install() {
    if (installing) return;
    setInstalling(true);
    setError(null);
    try {
      const res: InstallResponse = await fetch("/api/code-index/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }).then((r) => r.json());
      if (res.ok) setAvailable(true);
      // The failure is usually a long npm log; the last line is the part that says why.
      else setError(res.error ? res.error.split("\n").pop()!.slice(0, 120) : "Install failed.");
    } catch {
      setError("Install failed.");
    } finally {
      setInstalling(false);
    }
  }

  if (available === null) return <Loader2 className="size-3.5 animate-spin text-pebble" />;
  if (available) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-[12px] text-lichen-green">
        <Check className="size-3.5" /> installed
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={install}
        disabled={installing}
        className="flex items-center gap-1.5 rounded-lg bg-charcoal px-2.5 py-1.5 text-[12px] text-warm-bone disabled:opacity-40"
      >
        {installing && <Loader2 className="size-3.5 animate-spin" />}
        {installing ? "Installing…" : "Install"}
      </button>
      {error ? (
        <span className="max-w-[260px] text-right text-[11.5px] text-alarm-red">{error}</span>
      ) : (
        command && (
          <code className="max-w-[260px] truncate font-mono text-[11px] text-pebble" title={command}>
            or run: {command}
          </code>
        )
      )}
    </div>
  );
}
