"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutGrid, Columns3, Boxes, Bot, Settings, Plus, FolderPlus,
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
