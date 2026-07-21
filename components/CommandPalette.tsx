"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  LayoutGrid, MessageSquare, Columns3, Network, Boxes, Bot, Settings, Plus, FolderPlus,
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
  const act = (msg: string) => { setOpen(false); toast.success(msg); };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search or run a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => go("/")}><LayoutGrid className="size-4 text-pebble" /> Overview</CommandItem>
          <CommandItem onSelect={() => go("/chat")}><MessageSquare className="size-4 text-pebble" /> Chat</CommandItem>
          <CommandItem onSelect={() => go("/board")}><Columns3 className="size-4 text-pebble" /> Board</CommandItem>
          <CommandItem onSelect={() => go("/orchestrator")}><Network className="size-4 text-pebble" /> Runs</CommandItem>
          <CommandItem onSelect={() => go("/agents")}><Bot className="size-4 text-pebble" /> Agents</CommandItem>
          <CommandItem onSelect={() => go("/projects")}><Boxes className="size-4 text-pebble" /> Projects</CommandItem>
          <CommandItem onSelect={() => go("/settings")}><Settings className="size-4 text-pebble" /> Settings</CommandItem>
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => act("New session started")}>
            <Plus className="size-4 text-pebble" /> New session <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => act("New task created")}>
            <Plus className="size-4 text-pebble" /> New task
          </CommandItem>
          <CommandItem onSelect={() => go("/onboarding")}>
            <FolderPlus className="size-4 text-pebble" /> Add project…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
