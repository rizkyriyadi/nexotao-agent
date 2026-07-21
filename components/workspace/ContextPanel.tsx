"use client";

import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { IconFolder, IconFile } from "../icons";
import { useWorkspace } from "./workspace-context";

type Entry = { name: string; type: "dir" | "file" };

export function ContextPanel() {
  const { terminal, diff } = useWorkspace();
  const [files, setFiles] = useState<Entry[]>([]);

  const loadFiles = () =>
    fetch("/api/files?path=.")
      .then((r) => r.json())
      .then((d) => setFiles(d.entries ?? []))
      .catch(() => {});

  useEffect(() => {
    loadFiles();
  }, [diff]); // refresh when a file changes

  return (
    <Tabs defaultValue="files" className="flex h-full w-[380px] shrink-0 flex-col border-l border-line bg-warm-bone">
      <div className="flex h-14 shrink-0 items-center border-b border-line px-5">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="diff">Changes</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="files" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <p className="px-5 py-5 text-[13px] text-pebble">Empty project — the agent will create files here.</p>
        ) : (
          <ul className="py-3 font-mono text-[13px]">
            {files.map((n, i) => (
              <li key={i} className="flex items-center gap-2 px-5 py-[3px] hover:bg-black/[0.02]">
                {n.type === "dir" ? <IconFolder className="size-3.5 text-pebble" /> : <IconFile className="size-3.5 text-pebble" />}
                <span className="text-bark-grey">{n.name}{n.type === "dir" ? "/" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>

      <TabsContent value="diff" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {!diff ? (
          <p className="px-5 py-5 text-[13px] text-pebble">No changes yet.</p>
        ) : (
          <div>
            <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
              <span className="truncate font-mono text-[12.5px] text-charcoal">{diff.file}</span>
              <span className="label !text-lichen-green ml-1">written</span>
            </div>
            <pre className="scroll-thin overflow-x-auto py-2 font-mono text-[12.5px] leading-[1.6]">
              {diff.content.split("\n").map((l, i) => (
                <div key={i} className="diff-add flex">
                  <span className="w-9 shrink-0 select-none px-2 text-right text-pebble">{i + 1}</span>
                  <span className="w-3 shrink-0 select-none text-lichen-green">+</span>
                  <span className="whitespace-pre pr-5 text-charcoal">{l}</span>
                </div>
              ))}
            </pre>
          </div>
        )}
      </TabsContent>

      <TabsContent value="terminal" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {terminal.length === 0 ? (
          <p className="px-5 py-5 text-[13px] text-pebble">No commands run yet.</p>
        ) : (
          <pre className="scroll-thin overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-[1.7]">
            {terminal.map((l, i) => (
              <div key={i} className={l.startsWith("$ ") ? "text-charcoal" : "text-bark-grey"}>{l}</div>
            ))}
          </pre>
        )}
      </TabsContent>
    </Tabs>
  );
}
