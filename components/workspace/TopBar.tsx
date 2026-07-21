"use client";

import { useEffect, useState } from "react";

export function TopBar() {
  const [cfg, setCfg] = useState<{ model?: string | null; project?: { name?: string } | null }>({});

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setCfg).catch(() => {});
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
      <h1 className="truncate text-[15px] font-medium text-charcoal">New session</h1>
      <div className="flex items-center gap-4 font-mono text-[12px] text-pebble">
        <span>{cfg.project?.name ?? "no project"}</span>
        <span className="text-line-strong">|</span>
        <span>{cfg.model ?? "—"}</span>
      </div>
    </header>
  );
}
