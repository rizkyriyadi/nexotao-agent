"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Sparkles, Loader2 } from "lucide-react";
import { useState } from "react";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { useWorkspace, target, type Item } from "./workspace-context";

const SUGGESTIONS = [
  "Explain what this project does",
  "Add a login page with JWT auth",
  "Set up a health-check endpoint and a test",
];

const TOOL_LABEL: Record<string, string> = {
  list_dir: "List", read_file: "Read", write_file: "Write",
  edit_file: "Edit", bash: "Run", grep: "Grep",
};

function ToolRow({ it }: { it: Extract<Item, { kind: "tool" }> }) {
  return (
    <div className="-mx-2 flex items-center gap-3 rounded-md px-2 py-[5px]">
      <span className={`size-[6px] shrink-0 rounded-full ${it.status === "running" ? "bg-electric-indigo nx-pulse" : it.status === "error" ? "bg-alarm-red" : "bg-pebble"}`} />
      <span className="w-10 shrink-0 text-[13px] font-medium text-charcoal">{TOOL_LABEL[it.name] ?? it.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-bark-grey">{target(it.name, it.input)}</span>
      <span className={`shrink-0 font-mono text-[11px] ${it.status === "error" ? "text-alarm-red" : "text-pebble"}`}>
        {it.status === "running" ? "running" : it.display ?? (it.status === "error" ? "failed" : "done")}
      </span>
    </div>
  );
}

export function Chat() {
  const { items, streaming, send } = useWorkspace();
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const submit = () => {
    send(input);
    setInput("");
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-8 py-9">
          {items.length === 0 ? (
            <div className="flex flex-col items-center pt-14 text-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-mist-lavender text-electric-indigo">
                <Sparkles className="size-5" />
              </span>
              <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em] text-charcoal">What should we build?</h2>
              <p className="mt-1.5 text-[14px] text-bark-grey">The agent reads, edits, and runs code in this project — with your approval.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((it, i) =>
              it.kind === "user" ? (
                <div key={i}>
                  <p className="label mb-2.5">You</p>
                  <div className="rounded-2xl border border-line bg-paper-white px-4 py-3 text-[15px] leading-[1.6] text-charcoal">{it.text}</div>
                </div>
              ) : it.kind === "assistant" ? (
                it.text ? (
                  <div key={i}>
                    <p className="label mb-2.5">Agent</p>
                    <div className="whitespace-pre-wrap text-[15px] leading-[1.65] text-charcoal">
                      {it.text}
                      {it.streaming && <span className="nx-caret" />}
                    </div>
                  </div>
                ) : null
              ) : (
                <ToolRow key={i} it={it} />
              ),
            )
          )}
          {streaming && items[items.length - 1]?.kind !== "assistant" && (
            <div className="flex items-center gap-2 text-[13px] text-pebble">
              <Loader2 className="size-3.5 animate-spin" /> working…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="px-8 pb-6">
        <div className="mx-auto w-full max-w-[720px]">
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-paper-white p-2 transition-colors focus-within:border-bark-grey">
            <Textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Describe a task…"
              className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-[15px] shadow-none focus-visible:ring-0"
            />
            <Button size="icon" className="rounded-xl" disabled={streaming || !input.trim()} onClick={submit}>
              <ArrowUp className="size-4" />
            </Button>
          </div>
          <p className="mt-2 px-1 font-mono text-[11px] text-pebble">⏎ send · ⇧⏎ newline · live via Nexotao</p>
        </div>
      </div>
    </div>
  );
}
