"use client";

/* The workspace, docked beside the conversation rather than filed away on a
   page of its own.

   A separate page was the wrong shape: you look at files *because* of what the
   agent just said, and making that a navigation away from the transcript means
   losing your place to check a claim. Here the tree sits next to the prompt, and
   opening a file slides a reader over the tree rather than replacing the chat. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, FolderTree, Loader2, PanelRightClose, RefreshCw, Search } from "lucide-react";
import { FileTree } from "./FileTree";
import { FilePreviewPane } from "./FilePreview";
import type { TreeNode, WorkspaceRoot } from "@/lib/workspace-files";

/** Top-level folders start open. Landing on a wall of collapsed folders makes a
 *  small project look empty, which is the impression this panel exists to fix. */
function initialExpansion(tree: TreeNode[]) {
  return new Set(tree.filter((n) => n.type === "dir").slice(0, 3).map((n) => n.path));
}

export function WorkspaceDock({
  roots, root, tree, truncated, loading, error, onReload, onChoose, onClose,
}: {
  roots: WorkspaceRoot[];
  root: WorkspaceRoot | null;
  tree: TreeNode[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Seeded once, from whichever tree arrives first. Re-seeding on every poll
  // would snap folders shut under a user who had just opened them.
  useEffect(() => {
    if (seeded || !tree.length) return;
    setExpanded(initialExpansion(tree));
    setSeeded(true);
  }, [tree, seeded]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const select = useCallback((node: TreeNode) => setSelected(node.path), []);

  const fileCount = useMemo(() => {
    let n = 0;
    const count = (nodes: TreeNode[]) => nodes.forEach((node) => (node.type === "dir" ? count(node.children ?? []) : n++));
    count(tree);
    return n;
  }, [tree]);

  if (!loading && !roots.length) {
    return (
      <aside className="flex w-[320px] shrink-0 flex-col border-l border-line/70 bg-paper-white/40">
        <DockHeader onClose={onClose} />
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="text-center">
            <FolderTree className="mx-auto mb-3 size-6 text-pebble" strokeWidth={1.5} />
            <p className="text-[12.5px] text-charcoal">No project is open.</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-pebble">
              Open a folder from Projects, or start a task — files the agent creates show up here.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  // The reader takes the whole dock when a file is open. Splitting 320px between
  // a tree and a preview leaves neither usable.
  if (selected && root) {
    return (
      <aside className="flex w-[420px] shrink-0 flex-col border-l border-line/70 bg-paper-white/40">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line/70 px-2">
          <button
            type="button"
            onClick={() => setSelected(null)}
            title="Back to the tree"
            aria-label="Back to the file tree"
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-pebble transition-colors hover:bg-black/[0.035] hover:text-charcoal"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.8} /> Files
          </button>
          <span className="flex-1" />
          <CloseButton onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1">
          <FilePreviewPane root={root.id} path={selected} compact onSaved={onReload} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line/70 bg-paper-white/40">
      <DockHeader onClose={onClose} />

      <div className="shrink-0 space-y-2 px-3 pb-2">
        {roots.length > 1 ? (
          <label className="block">
            <span className="sr-only">Folder to browse</span>
            <select
              value={root?.id ?? ""}
              onChange={(event) => { setSelected(null); onChoose(event.target.value); }}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[12px] text-charcoal outline-none focus:border-line-strong"
            >
              {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
        ) : (
          <p className="truncate px-1 text-[12.5px] font-medium text-charcoal" title={root?.detail}>{root?.label ?? "Files"}</p>
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
            onClick={onReload}
            title="Reload the tree"
            aria-label="Reload the tree"
            className="shrink-0 rounded-lg border border-line p-1.5 text-pebble transition-colors hover:text-charcoal"
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" strokeWidth={1.8} />}
          </button>
        </div>

        <p className="px-1 text-[10.5px] text-pebble">
          {truncated
            ? `${fileCount.toLocaleString()} files shown — the tree was capped`
            : `${fileCount.toLocaleString()} file${fileCount === 1 ? "" : "s"}`}
          {root?.kind === "worktree" && <span className="ml-1 text-amber-700">· live run copy</span>}
        </p>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-2 pb-4">
        {error ? (
          <p className="px-2 py-6 text-[12px] text-alarm-red">{error}</p>
        ) : (
          <FileTree tree={tree} query={query} expanded={expanded} selected={selected} onToggle={toggle} onSelect={select} />
        )}
      </div>
    </aside>
  );
}

function DockHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line/70 px-3">
      <FolderTree className="size-3.5 text-pebble" strokeWidth={1.8} />
      <span className="flex-1 text-[12px] font-medium text-charcoal">Workspace</span>
      <CloseButton onClose={onClose} />
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      title="Hide the workspace"
      aria-label="Hide the workspace panel"
      className="rounded-lg p-1 text-pebble transition-colors hover:bg-black/[0.035] hover:text-charcoal"
    >
      <PanelRightClose className="size-3.5" strokeWidth={1.8} />
    </button>
  );
}
