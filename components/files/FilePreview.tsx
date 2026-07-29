"use client";

/* The reading half of the workspace panel. Each file kind gets the presentation
   it deserves: markdown rendered, code with line numbers, images on a checker
   backdrop, PDFs as their extracted text — the same text the agent reads. */

import { useEffect, useState } from "react";
import { FileQuestion, Loader2 } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { CopyButton } from "@/components/task/tool-atoms";
import type { FilePreview as Preview } from "@/lib/workspace-files";

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Code with a gutter. Line numbers are a separate column rather than part of
 *  the text so a copy or a drag-select takes the source and not the numbering. */
function Code({ text, language }: { text: string; language: string }) {
  const lines = text.split("\n");
  return (
    <div className="scroll-thin overflow-auto rounded-xl border border-line bg-[#faf9f7]">
      <div className="flex items-center justify-between border-b border-line bg-code-surface px-3 py-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-pebble">{language}</span>
        <span className="text-[10.5px] text-pebble">{`${lines.length} lines`}</span>
      </div>
      <div className="flex min-w-full font-mono text-[12.5px] leading-[1.65]">
        <div aria-hidden className="select-none border-r border-line px-2.5 py-3 text-right text-pebble/70">
          {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <pre className="flex-1 overflow-x-auto px-3 py-3 text-charcoal">{text}</pre>
      </div>
    </div>
  );
}

function Body({ preview }: { preview: Preview }) {
  if (preview.kind === "markdown") {
    return (
      <div className="rounded-xl border border-line bg-white/70 px-5 py-4">
        <Markdown>{preview.text}</Markdown>
      </div>
    );
  }
  if (preview.kind === "text") return <Code text={preview.text} language={preview.language} />;
  if (preview.kind === "image") {
    return (
      <div className="nx-checker flex items-center justify-center rounded-xl border border-line p-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL of a
            file on this machine; next/image would try to optimise it through a
            loader that has nothing to fetch. */}
        <img src={preview.dataUrl} alt={preview.name} className="max-h-[62vh] max-w-full rounded-md object-contain shadow-sm" />
      </div>
    );
  }
  if (preview.kind === "pdf") {
    return (
      <div className="rounded-xl border border-line bg-white/70 px-5 py-4">
        {!preview.ok && (
          <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
            No text could be extracted — this looks like a scanned PDF.
          </p>
        )}
        <pre className="whitespace-pre-wrap text-[13px] leading-[1.7] text-charcoal">{preview.text}</pre>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-16 text-center">
      <FileQuestion className="size-6 text-pebble" strokeWidth={1.6} />
      <p className="text-[12.5px] text-pebble">{preview.reason}</p>
    </div>
  );
}

export function FilePreviewPane({ root, path }: { root: string; path: string | null }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) { setPreview(null); setError(null); return; }
    // A fast click through the tree can land responses out of order; the flag
    // makes each effect discard its own result once a newer one has started.
    let stale = false;
    setLoading(true);
    setError(null);
    fetch(`/api/files/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        if (stale) return;
        if (body.error) { setError(body.error); setPreview(null); }
        else { setPreview(body as Preview); setError(null); }
      })
      .catch((cause) => { if (!stale) setError(String(cause)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [root, path]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="max-w-xs text-[12.5px] leading-relaxed text-pebble">
          Pick a file to read it. Markdown, PDFs, images and code all render here — the same files the agent sees.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-charcoal">{preview?.name ?? path.split("/").pop()}</p>
          <p className="truncate text-[11px] text-pebble">{path}</p>
        </div>
        {preview && <span className="shrink-0 text-[11px] text-pebble">{humanSize(preview.size)}</span>}
        {preview && (preview.kind === "text" || preview.kind === "markdown" || preview.kind === "pdf") && (
          <CopyButton text={preview.text} label="Copy file contents" />
        )}
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4">
        {loading && !preview && (
          <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-pebble">
            <Loader2 className="size-3.5 animate-spin" /> Reading…
          </div>
        )}
        {error && <p className="rounded-xl border border-alarm-red/25 bg-alarm-red/5 px-3 py-2.5 text-[12.5px] text-alarm-red">{error}</p>}
        {preview && !error && (
          <>
            {"truncated" in preview && preview.truncated && (
              <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-700">
                Showing the first 512 KB — this file is larger than that.
              </p>
            )}
            <Body preview={preview} />
          </>
        )}
      </div>
    </div>
  );
}
