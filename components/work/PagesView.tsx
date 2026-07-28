"use client";

/* Pages: the writing surface beside the board. A page is a document — the same
   `documents` rows the rest of the app already versions — so every save keeps a
   revision without a second history mechanism to keep honest. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { shortDate } from "./parts";
import type { Page } from "@/lib/work-model";

export function PagesView() {
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/work/pages", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setPages(body.pages); else toast.error(body.error ?? "Could not load pages");
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!title.trim()) return;
    const response = await fetch("/api/work/pages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), body: "" }),
    });
    const body = await response.json();
    if (!response.ok) { toast.error(body.error ?? "Could not create that page"); return; }
    setTitle("");
    await load();
    toast.success(`${body.page.title} created`);
  };

  if (loading) return <p className="text-sm text-pebble">Loading pages…</p>;

  const live = pages.filter((page) => !page.archivedAt);
  const archived = pages.filter((page) => page.archivedAt);

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => { event.preventDefault(); void create(); }}
        className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-white/60 p-3"
      >
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-pebble">
          Title
          <input
            value={title} onChange={(event) => setTitle(event.target.value)}
            placeholder="Release notes" aria-label="Page title"
            className="w-full rounded-lg border border-line bg-white px-2 py-1 text-[12.5px] text-charcoal outline-none focus:border-line-strong"
          />
        </label>
        <button type="submit" disabled={!title.trim()}
          className="rounded-lg bg-electric-indigo px-3 py-1.5 text-[12px] text-white disabled:opacity-40">
          New page
        </button>
      </form>

      {!live.length && !archived.length && (
        <p className="rounded-xl border border-dashed border-line px-3 py-10 text-center text-xs text-pebble">
          No pages yet. A page is a place to write things down that are not work items — a spec, a decision, a set of notes.
        </p>
      )}

      <ul className="space-y-1.5">
        {live.map((page) => (
          <li key={page.id}>
            <Link href={`/work/pages/${page.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-white/60 px-3 py-2.5 transition-colors hover:border-line-strong">
              <span className="min-w-0 flex-1 truncate text-[13px] text-charcoal">{page.title}</span>
              <span className="shrink-0 text-[11px] text-pebble">{shortDate(page.updatedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>

      {archived.length > 0 && (
        <details className="rounded-xl border border-line bg-white/40 px-3 py-2">
          <summary className="cursor-pointer text-[11.5px] text-pebble">Archived ({archived.length})</summary>
          <ul className="mt-2 space-y-1">
            {archived.map((page) => (
              <li key={page.id}>
                <Link href={`/work/pages/${page.id}`} className="flex items-center gap-2 py-1 text-[12.5px] text-pebble hover:text-charcoal">
                  <span className="min-w-0 flex-1 truncate">{page.title}</span>
                  <span className="shrink-0 text-[11px]">{shortDate(page.archivedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
