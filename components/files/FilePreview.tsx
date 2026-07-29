"use client";

/* The reading half of the workspace panel. Each file kind gets the presentation
   it deserves: markdown rendered, code with line numbers, images on a checker
   backdrop, PDFs as their extracted text — the same text the agent reads.
   Text files can be switched into an editor and saved back. */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Eye, FileQuestion, Loader2, Pencil, RotateCcw } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { CopyButton } from "@/components/task/tool-atoms";
import { FileEditor } from "./FileEditor";
import type { FilePreview as Preview } from "@/lib/workspace-files";

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Text kinds are the ones an edit makes sense on. A PDF's preview is extracted
 *  text, not the file — saving it would replace the document with its own
 *  transcript. */
function editable(preview: Preview): preview is Extract<Preview, { kind: "text" | "markdown" }> {
  return (preview.kind === "text" || preview.kind === "markdown") && !preview.truncated;
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

export function FilePreviewPane({
  root, path, compact, onSaved,
}: {
  root: string;
  path: string | null;
  /** Tighter chrome for the dock beside the composer, where horizontal room is
   *  scarce — the same component rather than a second, drifting copy. */
  compact?: boolean;
  onSaved?: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) { setPreview(null); setError(null); setDraft(null); return; }
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
        // Switching files always leaves the editor. Carrying a draft across a
        // selection change would offer to save one file's text into another.
        setDraft(null);
      })
      .catch((cause) => { if (!stale) setError(String(cause)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [root, path, nonce]);

  const save = useCallback(async () => {
    if (!preview || draft === null || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path: preview.path, text: draft, version: { size: preview.size, mtimeMs: preview.mtimeMs } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Couldn't save");
      toast.success(`Saved ${preview.name}`);
      setDraft(null);
      setNonce((n) => n + 1);
      onSaved?.();
    } catch (cause: any) {
      toast.error(String(cause?.message ?? cause));
    } finally {
      setSaving(false);
    }
  }, [preview, draft, saving, root, onSaved]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="max-w-xs text-[12.5px] leading-relaxed text-pebble">
          Pick a file to read it. Markdown, PDFs, images and code all render here — the same files the agent sees.
        </p>
      </div>
    );
  }

  const editing = draft !== null;
  const dirty = editing && preview && "text" in preview && draft !== preview.text;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={`flex shrink-0 items-center gap-2 border-b border-line ${compact ? "px-3 py-2" : "px-5 py-3"}`}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-charcoal">
            {preview?.name ?? path.split("/").pop()}
            {dirty && <span className="ml-1.5 text-[11px] font-normal text-amber-700">· unsaved</span>}
          </p>
          {!compact && <p className="truncate text-[11px] text-pebble">{path}</p>}
        </div>
        {preview && !editing && <span className="shrink-0 text-[11px] text-pebble">{humanSize(preview.size)}</span>}

        {preview && editable(preview) && !editing && (
          <button
            type="button"
            onClick={() => setDraft(preview.text)}
            title="Edit this file"
            aria-label="Edit this file"
            className="shrink-0 rounded-lg border border-line p-1.5 text-pebble transition-colors hover:text-charcoal"
          >
            <Pencil className="size-3.5" strokeWidth={1.8} />
          </button>
        )}

        {editing && (
          <>
            <button
              type="button"
              onClick={() => setDraft(null)}
              title="Discard changes"
              aria-label="Discard changes and go back to reading"
              className="shrink-0 rounded-lg border border-line p-1.5 text-pebble transition-colors hover:text-charcoal"
            >
              {dirty ? <RotateCcw className="size-3.5" strokeWidth={1.8} /> : <Eye className="size-3.5" strokeWidth={1.8} />}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              title="Save (⌘S)"
              aria-label="Save this file"
              className="flex shrink-0 items-center gap-1 rounded-lg bg-electric-indigo px-2.5 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2.2} />} Save
            </button>
          </>
        )}

        {preview && !editing && (preview.kind === "text" || preview.kind === "markdown" || preview.kind === "pdf") && (
          <CopyButton text={preview.text} label="Copy file contents" />
        )}
      </header>

      <div className={`scroll-thin flex min-h-0 flex-1 flex-col overflow-auto ${compact ? "p-2.5" : "p-4"}`}>
        {loading && !preview && (
          <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-pebble">
            <Loader2 className="size-3.5 animate-spin" /> Reading…
          </div>
        )}
        {error && <p className="rounded-xl border border-alarm-red/25 bg-alarm-red/5 px-3 py-2.5 text-[12.5px] text-alarm-red">{error}</p>}
        {preview && !error && (
          editing ? (
            <FileEditor
              value={draft}
              onChange={setDraft}
              language={preview.kind === "text" ? preview.language : "markdown"}
              onSave={() => void save()}
              saving={saving}
            />
          ) : (
            <>
              {"truncated" in preview && preview.truncated && (
                <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-700">
                  Showing the first 512 KB — this file is larger than that, so it can be read here but not edited.
                </p>
              )}
              <Body preview={preview} />
            </>
          )
        )}
      </div>
    </div>
  );
}
