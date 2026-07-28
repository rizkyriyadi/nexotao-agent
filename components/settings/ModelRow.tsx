"use client";

import { useEffect, useState } from "react";

/** Prettify a model id for display: "claude-opus-4-8" -> "Opus 4.8". Falls back
 *  to the raw id for anything that doesn't parse, so an unknown model still
 *  names itself rather than rendering blank. */
export function modelLabel(id: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(id);
  if (claude) {
    const [, tier, major, minor] = claude;
    const name = tier[0].toUpperCase() + tier.slice(1);
    return `${name} ${major}${minor ? `.${minor}` : ""}`;
  }
  const gpt = /^gpt-([\d.]+)-(\w+)$/.exec(id);
  if (gpt) return `GPT-${gpt[1]} ${gpt[2][0].toUpperCase() + gpt[2].slice(1)}`;
  return id;
}

/** The model actually in use, read from config rather than hardcoded. The
 *  catalogue is consulted only for its display name; if it can't be reached the
 *  id still renders through `modelLabel`. */
export function ModelRow() {
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await fetch("/api/config").then((r) => r.json());
        if (cancelled) return;
        const current = config.model ?? null;
        setId(current);
        if (!current) return;
        const { models } = await fetch("/api/models").then((r) => r.json());
        if (cancelled) return;
        setName(models?.find((m: { id: string }) => m.id === current)?.name ?? null);
      } catch {
        // Leave whatever we already have; the id alone is still informative.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!id) return <span className="font-mono text-[13px] text-pebble">—</span>;
  return (
    <span className="font-mono text-[13px] text-charcoal" title={id}>
      {name ?? modelLabel(id)}
    </span>
  );
}
