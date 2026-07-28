"use client";

import { useEffect, useState } from "react";
import { IconKeyStub } from "@/components/settings-icons";

/** The key actually in use, identified by its last four characters. The key
 *  itself never leaves the server — `/api/config` returns only the hint. */
export function ApiKeyRow() {
  const [state, setState] = useState<{ hasKey: boolean; hint: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setState({ hasKey: !!d.hasKey, hint: d.keyHint ?? null }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!state) return <span className="font-mono text-[13px] text-pebble">—</span>;
  if (!state.hasKey) return <span className="font-mono text-[13px] text-pebble">not set</span>;
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[13px] text-charcoal">
      <IconKeyStub className="size-4 text-pebble" />
      sk-nexo-••••{state.hint ? ` ${state.hint}` : ""}
    </span>
  );
}
