"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Sparkles, Loader2, Paperclip, X, FileText, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Markdown } from "../ui/markdown";
import { useWorkspace, target, type Item } from "./workspace-context";

const SUGGESTIONS = [
  "Explain what this project does",
  "Add a login page with JWT auth",
  "Set up a health-check endpoint and a test",
];

const TOOL_LABEL: Record<string, string> = {
  list_dir: "List", read_file: "Read", write_file: "Write",
  edit_file: "Edit", bash: "Run", grep: "Grep",
  web_search: "Search", web_fetch: "Fetch",
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

type Attach = { name: string; content: string };
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|env|csv|tsv|html?|xml|svg|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|zsh|sql|graphql|prisma|vue|astro|dockerfile|makefile|gitignore|log|text)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i;

async function fileToB64(f: File): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
  return dataUrl.split(",")[1] ?? "";
}

export function Chat() {
  const { items, streaming, send, cancel } = useWorkspace();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Attach[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  async function onPick(list: FileList | null) {
    if (!list) return;
    const picked: Attach[] = [];
    for (const f of Array.from(list)) {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      const isText = f.type.startsWith("text/") || f.type === "application/json" || TEXT_EXT.test(f.name);
      if (IMG_EXT.test(f.name) || f.type.startsWith("image/")) {
        toast.error(`${f.name}: images need vision, which Nexotao doesn't support yet.`);
        continue;
      }
      if (isPdf) {
        if (f.size > 15_000_000) { toast.error(`${f.name} is too large (max 15MB).`); continue; }
        try {
          const dataB64 = await fileToB64(f);
          const r = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, dataB64 }) }).then((x) => x.json());
          if (!r.ok) { toast.error(r.text || `${f.name}: could not extract text.`); continue; }
          picked.push({ name: f.name, content: r.text });
        } catch { toast.error(`${f.name}: extraction failed.`); }
        continue;
      }
      if (!isText) {
        toast.error(`${f.name}: unsupported file type (text, code, and PDF only).`);
        continue;
      }
      if (f.size > 400_000) { toast.error(`${f.name} is too large (max 400KB).`); continue; }
      picked.push({ name: f.name, content: await f.text() });
    }
    if (picked.length) setFiles((prev) => [...prev, ...picked]);
    if (fileRef.current) fileRef.current.value = "";
  }

  const submit = () => {
    const typed = input.trim();
    if ((!typed && !files.length) || streaming) return;
    const attachBlocks = files.map((f) => `--- Attached file: ${f.name} ---\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");
    const full = [typed, attachBlocks].filter(Boolean).join("\n\n");
    send(full, { display: typed || "(sent files)", files: files.map((f) => f.name) });
    setInput("");
    setFiles([]);
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
                  <div className="rounded-2xl border border-line bg-paper-white px-4 py-3 text-[15px] leading-[1.6] text-charcoal">
                    {(it.display ?? it.text).trim() || "(sent files)"}
                    {it.files && it.files.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {it.files.map((n, k) => (
                          <span key={k} className="flex items-center gap-1.5 rounded-lg border border-line bg-warm-bone px-2 py-1 font-mono text-[11.5px] text-bark-grey">
                            <FileText className="size-3.5 text-pebble" /> {n}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : it.kind === "assistant" ? (
                it.text ? (
                  <div key={i}>
                    <p className="label mb-2.5">Agent</p>
                    <div>
                      <Markdown>{it.text}</Markdown>
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
          {files.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span key={i} className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-paper-white px-2 py-1 font-mono text-[11.5px] text-bark-grey">
                  <FileText className="size-3.5 text-pebble" /> {f.name}
                  <button onClick={() => setFiles((prev) => prev.filter((_, k) => k !== i))} className="text-pebble hover:text-charcoal"><X className="size-3" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-paper-white p-2 transition-colors focus-within:border-bark-grey">
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => onPick(e.target.files)} />
            <Button size="icon" variant="ghost" className="rounded-xl text-pebble hover:text-charcoal" onClick={() => fileRef.current?.click()} title="Attach text/code files">
              <Paperclip className="size-4" />
            </Button>
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
              placeholder="Describe a task…  (⌘ attach files)"
              className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-[15px] shadow-none focus-visible:ring-0"
            />
            {streaming ? (
              <Button size="icon" variant="outline" className="rounded-xl" onClick={cancel} title="Cancel run"><Square className="size-3.5" /></Button>
            ) : (
              <Button size="icon" className="rounded-xl" disabled={!input.trim() && !files.length} onClick={submit}><ArrowUp className="size-4" /></Button>
            )}
          </div>
          <p className="mt-2 px-1 font-mono text-[11px] text-pebble">⏎ send · ⇧⏎ newline · 📎 attach text/code/PDF · web search + fetch enabled</p>
        </div>
      </div>
    </div>
  );
}
