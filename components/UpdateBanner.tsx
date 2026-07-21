"use client";

import { useEffect, useState } from "react";
import { ArrowUpCircle, X, Copy, Check } from "lucide-react";

/** A quiet banner that appears when a newer nexotao is on npm. Updating is a
 * plain `npm i -g nexotao@latest` — all data lives in ~/.nexotao, outside the
 * package, so nothing is lost. Dismissal is remembered per version. */
export function UpdateBanner() {
  const [info, setInfo] = useState<{ latest: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const cmd = "npm i -g nexotao@latest";

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((d) => {
        if (d.updateAvailable && localStorage.getItem("nx-dismiss-update") !== d.latest) setInfo({ latest: d.latest });
      })
      .catch(() => {});
  }, []);

  if (!info) return null;

  return (
    <div className="flex items-center gap-3 border-b border-line bg-mist-lavender/50 px-6 py-2.5 text-[13px]">
      <ArrowUpCircle className="size-4 shrink-0 text-electric-indigo" />
      <span className="text-charcoal">
        Update available — <span className="font-medium">v{info.latest}</span>. Your projects & history in <code className="rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[11px]">~/.nexotao</code> are kept.
      </span>
      <button
        onClick={() => { navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-paper-white px-2.5 py-1 font-mono text-[11.5px] text-charcoal transition-colors hover:border-charcoal"
      >
        {copied ? <Check className="size-3.5 text-lichen-green" /> : <Copy className="size-3.5 text-pebble" />} {cmd}
      </button>
      <button onClick={() => { localStorage.setItem("nx-dismiss-update", info.latest); setInfo(null); }} className="ml-auto text-pebble hover:text-charcoal">
        <X className="size-4" />
      </button>
    </div>
  );
}
