"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Scissors, LayoutGrid, Columns3, Boxes, Bot, Settings, CircleHelp, Inbox as InboxIcon, Share2, Store, Users, Table2,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { ThemeToggle } from "./Theme";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { useInboxSignal } from "./inbox/useInboxSignal";

// One control panel: the board is where every task and run lives — there is no
// longer a separate chat session or runs surface. `/work` sits beside it rather
// than replacing it: the same issues, organised instead of conversed with.
//
// Files are not here. They are docked to the right of the prompt on the board
// and on every task, because you open a file *because of* what the agent just
// said — and a destination you navigate to costs you your place in that
// conversation to check a single claim.
const NAV = [
  { id: "home", href: "/", label: "Overview", icon: LayoutGrid },
  { id: "board", href: "/board", label: "Control Panel", icon: Columns3 },
  { id: "work", href: "/work", label: "Work Items", icon: Table2 },
  { id: "team-room", href: "/team-room", label: "Live Team Room", icon: Users },
  { id: "inbox", href: "/inbox", label: "Approval Inbox", icon: InboxIcon },
  { id: "agents", href: "/agents", label: "Agents", icon: Bot },
  { id: "marketplace", href: "/marketplace", label: "Marketplace", icon: Store },
  { id: "graph", href: "/graph", label: "Knowledge Graph", icon: Share2 },
  { id: "projects", href: "/projects", label: "Projects", icon: Boxes },
];

const SHORTCUTS: [string, string][] = [
  ["Command palette", "⌘ K"],
  ["New task", "⌘ N"],
  ["Interrupt run", "esc"],
  ["Send message", "⏎"],
  ["Newline", "⇧ ⏎"],
];

export function IconRail({ active }: { active: string }) {
  const [help, setHelp] = useState(false);
  const inbox = useInboxSignal();

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
          const badge = n.id === "inbox" ? inbox.count : 0;
          const label =
            n.id === "inbox" && badge
              ? `${n.label}, ${badge} needing attention${inbox.hasUnread ? `, ${inbox.unread} new` : ""}`
              : n.label;
          return (
            <Tooltip key={n.id}>
              <TooltipTrigger asChild>
                <Link
                  href={n.href}
                  aria-label={label}
                  className={`relative flex size-10 items-center justify-center rounded-2xl transition-colors ${
                    on ? "bg-electric-indigo text-on-indigo shadow-sm" : "text-pebble hover:bg-veil hover:text-charcoal"
                  }`}
                >
                  <Icon className="size-[18px]" strokeWidth={on ? 2 : 1.75} />
                  {badge > 0 && (
                    <span
                      aria-hidden
                      className={`absolute -right-0.5 -top-0.5 flex min-w-[17px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-[17px] ring-2 ring-warm-bone ${
                        inbox.hasUnread ? "animate-pulse bg-electric-indigo text-on-indigo" : "bg-line-strong text-bark-grey"
                      }`}
                    >
                      {badge > 9 ? "9+" : badge}
                    </span>
                  )}
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <ThemeToggle />
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/settings"
              aria-label="Settings"
              className={`flex size-10 items-center justify-center rounded-2xl transition-colors ${
                active === "settings" ? "bg-veil text-charcoal" : "text-pebble hover:bg-veil hover:text-charcoal"
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
              aria-label="Help and shortcuts"
              className="flex size-10 items-center justify-center rounded-2xl text-pebble transition-colors hover:bg-veil hover:text-charcoal"
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
