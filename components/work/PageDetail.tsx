"use client";

/* One page, in two modes. Editing is a plain textarea over markdown — the same
   text the rest of the app renders — and reading is the shared `Markdown`
   component, so a page cannot drift into looking unlike every other document
   here.

   Saving appends a revision rather than overwriting, which is why there is no
   autosave: a revision per keystroke is a history nobody can read. */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Markdown } from "@/components/ui/markdown";
import { shortDate } from "./parts";
import type { Page } from "@/lib/work-model";

type Loaded = Page & { body: string; revision: number };

export function PageDetail({ id }: { id: string }) {
  const [page, setPage] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/work/pages/${id}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error ?? "Could not load that page"); return; }
    setPage(payload.page);
    setTitle(payload.page.title);
    setBody(payload.page.body);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const patch = async (fields: Record<string, unknown>) => {
    const response = await fetch(`/api/work/pages/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const payload = await response.json();
    if (!response.ok) { toast.error(payload.error ?? "Could not save that page"); return false; }
    setPage(payload.page);
    return true;
  };

  const save = async () => {
    setSaving(true);
    // Title and body ride in one PATCH so a save is one revision, not two.
    const ok = await patch({ title, body });
    setSaving(false);
    if (!ok) return;
    setEditing(false);
    toast.success("Page saved");
  };

  /** Turn the selected text into a work item. The first line becomes the title
   *  and the rest becomes the detail — which is how a heading followed by a
   *  paragraph reads once it is a card. */
  const convertSelection = async () => {
    const field = editor.current;
    const selected = field ? field.value.slice(field.selectionStart, field.selectionEnd).trim() : "";
    if (!selected) { toast.error("Select the text to turn into a work item first"); return; }
    const [first, ...rest] = selected.split("\n");
    const response = await fetch("/api/work/issues", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: first.replace(/^#+\s*/, "").slice(0, 500),
        detail: rest.join("\n").trim(),
        intakeSource: "user",
      }),
    });
    const payload = await response.json();
    if (!response.ok) { toast.error(payload.error ?? "Could not create that work item"); return; }
    toast.success(`${payload.issue.ref} created from selection`);
  };

  if (error) return <p className="rounded-2xl border border-line bg-raise/60 p-8 text-center text-sm text-pebble">{error}</p>;
  if (!page) return <p className="text-sm text-pebble">Loading page…</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/work/pages" className="text-[12px] text-electric-indigo">← All pages</Link>
        <span className="text-[11px] text-pebble">revision {page.revision} · saved {shortDate(page.updatedAt)}</span>
        <div className="ml-auto flex items-center gap-2">
          {editing && (
            <button onClick={() => void convertSelection()} className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-charcoal hover:border-line-strong">
              Selection → work item
            </button>
          )}
          <button
            onClick={() => void patch({ archivedAt: page.archivedAt ? null : Date.now() })}
            className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-pebble hover:border-line-strong hover:text-charcoal"
          >
            {page.archivedAt ? "Unarchive" : "Archive"}
          </button>
          {editing ? (
            <button onClick={() => void save()} disabled={saving}
              className="rounded-lg bg-electric-indigo px-3 py-1.5 text-[12px] text-on-indigo disabled:opacity-40">
              {saving ? "Saving…" : "Save"}
            </button>
          ) : (
            <button onClick={() => setEditing(true)} className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-charcoal hover:border-line-strong">
              Edit
            </button>
          )}
        </div>
      </div>

      {page.archivedAt && (
        <p className="rounded-lg border border-line bg-veil px-3 py-1.5 text-[11.5px] text-pebble">
          This page is archived. It stays readable and can be brought back at any time.
        </p>
      )}

      {editing ? (
        <div className="space-y-2">
          <input
            value={title} onChange={(event) => setTitle(event.target.value)}
            aria-label="Page title"
            className="w-full rounded-xl border border-line bg-raise px-3 py-2 font-serif text-2xl text-charcoal outline-none focus:border-line-strong"
          />
          <textarea
            ref={editor} value={body} onChange={(event) => setBody(event.target.value)}
            aria-label="Page body" spellCheck={false}
            placeholder="Write in markdown. Headings, lists, tables and code fences all render."
            className="scroll-thin min-h-[420px] w-full rounded-xl border border-line bg-raise px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-charcoal outline-none focus:border-line-strong"
          />
        </div>
      ) : (
        <article className="rounded-2xl border border-line bg-raise/60 p-6">
          <h2 className="font-serif text-2xl text-charcoal">{page.title}</h2>
          <div className="mt-3">
            {page.body.trim()
              ? <Markdown>{page.body}</Markdown>
              : <p className="text-[12.5px] text-pebble">This page is empty. Press Edit to start writing.</p>}
          </div>
        </article>
      )}
    </div>
  );
}
