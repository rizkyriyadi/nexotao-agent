"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutGrid, Columns3, Boxes, Bot, Settings, Plus, FolderPlus,
  Table2, CalendarRange, Layers, FileText, Inbox, ChartNoAxesColumn,
} from "lucide-react";
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut,
} from "./ui/command";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const go = (href: string) => { setOpen(false); router.push(href); };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search or run a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => go("/")}><LayoutGrid className="size-4 text-pebble" /> Overview</CommandItem>
          <CommandItem onSelect={() => go("/board")}><Columns3 className="size-4 text-pebble" /> Control Panel</CommandItem>
          <CommandItem onSelect={() => go("/agents")}><Bot className="size-4 text-pebble" /> Agents</CommandItem>
          <CommandItem onSelect={() => go("/projects")}><Boxes className="size-4 text-pebble" /> Projects</CommandItem>
          <CommandItem onSelect={() => go("/settings")}><Settings className="size-4 text-pebble" /> Settings</CommandItem>
        </CommandGroup>
        {/* Its own group: the work surface has six rooms, and folding them into
            "Go to" would bury the five top-level destinations above. */}
        <CommandGroup heading="Work">
          <CommandItem onSelect={() => go("/work")}><Table2 className="size-4 text-pebble" /> Work Items</CommandItem>
          <CommandItem onSelect={() => go("/work/cycles")}><CalendarRange className="size-4 text-pebble" /> Cycles</CommandItem>
          <CommandItem onSelect={() => go("/work/modules")}><Layers className="size-4 text-pebble" /> Modules</CommandItem>
          <CommandItem onSelect={() => go("/work/pages")}><FileText className="size-4 text-pebble" /> Pages</CommandItem>
          <CommandItem onSelect={() => go("/work/intake")}><Inbox className="size-4 text-pebble" /> Intake</CommandItem>
          <CommandItem onSelect={() => go("/work/analytics")}><ChartNoAxesColumn className="size-4 text-pebble" /> Analytics</CommandItem>
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => go("/board")}>
            <Plus className="size-4 text-pebble" /> New task <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/onboarding")}>
            <FolderPlus className="size-4 text-pebble" /> Add project…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
