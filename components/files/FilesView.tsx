"use client";

/* The workspace surface: what is actually on disk, beside a reader for it.
   It exists because "the agent wrote four files" and "my folder looks empty"
   were both true at once — the work was in a run's working copy, and nothing
   in the app ever showed that folder. The root switcher is the fix. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderTree, Loader2, RefreshCw, Search } from "lucide-react";
import { FileTree } from "./FileTree";
import { FilePreviewPane } from "./FilePreview";
import type { TreeNode, WorkspaceRoot } from "@/lib/workspace-files";

/** Top-level folders start open. Landing on a wall of collapsed folders makes a
 *  small project look empty, which is the impression this panel exists to fix. */
function initialExpansion(tree: TreeNode[]) {
  return new Set(tree.filter((n) => n.type === "dir").slice(0, 3).map((n) => n.path));
}

export function FilesView() {
  const [roots, setRoots] = useState<WorkspaceRoot[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string | null, keepSelection: boolean) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/files${id ? `?root=${encodeURIComponent(id)}` : ""}`, { cache: "no-store" });
      const body = await response.json();
      if (body.error) { setError(body.error); return; }
      setError(null);
      setRoots(body.roots ?? []);
      setRootId(body.root?.id ?? null);
      setTree(body.tree ?? []);
      setTruncated(Boolean(body.truncated));
      setExpanded((current) => (current.size && keepSelection ? current : initialExpansion(body.tree ?? [])));
      if (!keepSelection) setSelected(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(null, false); }, [load]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const select = useCallback((node: TreeNode) => setSelected(node.path), []);

  const active = useMemo(() => roots.find((r) => r.id === rootId) ?? null, [roots, rootId]);
  const fileCount = useMemo(() => {
    let n = 0;
    const count = (nodes: TreeNode[]) => nodes.forEach((node) => (node.type === "dir" ? count(node.children ?? []) : n++));
    count(tree);
    return n;
  }, [tree]);

  if (!loading && !roots.length) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <FolderTree className="mx-auto mb-3 size-7 text-pebble" strokeWidth={1.5} />
          <p className="text-[13px] text-charcoal">No project is open.</p>
          <p className="mt-1 text-[12px] text-pebble">Open a folder from Projects and its files will show up here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
          {roots.length > 1 ? (
            <label className="block">
              <span className="sr-only">Folder to browse</span>
              <select
                value={rootId ?? ""}
                onChange={(event) => { setSelected(null); void load(event.target.value, false); }}
                className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[12px] text-charcoal outline-none focus:border-line-strong"
              >
                {roots.map((root) => <option key={root.id} value={root.id}>{root.label}</option>)}
              </select>
            </label>
          ) : (
            <p className="truncate px-1 text-[12.5px] font-medium text-charcoal" title={active?.detail}>{active?.label ?? "Files"}</p>
          )}

          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-pebble" strokeWidth={2} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find files"
                aria-label="Find files by name or path"
                className="w-full rounded-lg border border-line bg-white py-1.5 pl-7 pr-2 text-[12px] text-charcoal outline-none placeholder:text-pebble focus:border-line-strong"
              />
            </div>
            <button
              type="button"
              onClick={() => void load(rootId, true)}
              title="Reload the tree"
              aria-label="Reload the tree"
              className="shrink-0 rounded-lg border border-line p-1.5 text-pebble transition-colors hover:text-charcoal"
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" strokeWidth={1.8} />}
            </button>
          </div>

          {/* The count sits under the search box rather than in a footer: the
              active-run indicator floats over the bottom-left corner, and a
              footer there is hidden exactly while a run is writing files. */}
          <p className="px-1 text-[10.5px] text-pebble">
            {truncated
              ? `${fileCount.toLocaleString()} files shown — the tree was capped`
              : `${fileCount.toLocaleString()} file${fileCount === 1 ? "" : "s"}`}
            {active?.kind === "worktree" && <span className="ml-1 text-amber-700">· live run copy</span>}
          </p>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-auto px-2 pb-16">
          {error ? (
            <p className="px-2 py-6 text-[12px] text-alarm-red">{error}</p>
          ) : (
            <FileTree tree={tree} query={query} expanded={expanded} selected={selected} onToggle={toggle} onSelect={select} />
          )}
        </div>
      </aside>

      <section className="min-w-0 flex-1">
        {active && <FilePreviewPane root={active.id} path={selected} />}
      </section>
    </div>
  );
}
