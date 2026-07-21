"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Scissors, LayoutGrid, MessageSquare, Columns3, Network, Boxes, Bot, Settings, CircleHelp,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";

const NAV = [
  { id: "home", href: "/", label: "Overview", icon: LayoutGrid },
  { id: "chat", href: "/chat", label: "Chat", icon: MessageSquare },
  { id: "board", href: "/board", label: "Board", icon: Columns3 },
  { id: "runs", href: "/orchestrator", label: "Runs", icon: Network },
  { id: "agents", href: "/agents", label: "Agents", icon: Bot },
  { id: "projects", href: "/projects", label: "Projects", icon: Boxes },
];

const SHORTCUTS: [string, string][] = [
  ["Command palette", "⌘ K"],
  ["New session", "⌘ N"],
  ["Interrupt run", "esc"],
  ["Send message", "⏎"],
  ["Newline", "⇧ ⏎"],
];

export function IconRail({ active }: { active: string }) {
  const [help, setHelp] = useState(false);

  return (
    <nav className="flex w-16 shrink-0 flex-col items-center py-4">
      <Link
        href="/"
        title="Nexotao Agents"
        className="mb-6 flex size-9 items-center justify-center rounded-2xl bg-electric-indigo/12 text-electric-indigo"
      >
        <Scissors className="size-[18px]" strokeWidth={1.8} />
      </Link>

      <div className="flex flex-1 flex-col items-center gap-1.5">
        {NAV.map((n) => {
          const Icon = n.icon;
          const on = active === n.id;
          return (
            <Tooltip key={n.id}>
              <TooltipTrigger asChild>
                <Link
                  href={n.href}
                  className={`flex size-10 items-center justify-center rounded-2xl transition-colors ${
                    on ? "bg-electric-indigo text-white shadow-sm" : "text-pebble hover:bg-black/[0.04] hover:text-charcoal"
                  }`}
                >
                  <Icon className="size-[18px]" strokeWidth={on ? 2 : 1.75} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{n.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/settings"
              className={`flex size-10 items-center justify-center rounded-2xl transition-colors ${
                active === "settings" ? "bg-black/[0.05] text-charcoal" : "text-pebble hover:bg-black/[0.04] hover:text-charcoal"
              }`}
            >
              <Settings className="size-[18px]" strokeWidth={1.75} />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setHelp(true)}
              className="flex size-10 items-center justify-center rounded-2xl text-pebble transition-colors hover:bg-black/[0.04] hover:text-charcoal"
            >
              <CircleHelp className="size-[18px]" strokeWidth={1.75} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Help &amp; shortcuts</TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Everything runs locally. Press ⌘K anywhere to jump around.</DialogDescription>
          </DialogHeader>
          <ul className="mt-1 divide-y divide-line">
            {SHORTCUTS.map(([label, keys]) => (
              <li key={label} className="flex items-center justify-between py-2.5 text-[13.5px]">
                <span className="text-charcoal">{label}</span>
                <kbd className="rounded-md border border-line-strong bg-muted px-2 py-0.5 font-mono text-[11px] text-bark-grey">
                  {keys}
                </kbd>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
