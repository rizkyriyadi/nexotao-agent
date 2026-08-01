"use client";

/* One reader of the workspace tree, shared by the dock and the composer's `@`
   picker. Two independent fetchers would walk the same folders twice and, worse,
   drift: mentioning a file the tree beside you does not list is the kind of
   inconsistency that makes a panel feel broken. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TreeNode, WorkspaceRoot } from "@/lib/workspace-files";

export type WorkspaceState = {
  root: WorkspaceRoot | null;
  tree: TreeNode[];
  paths: string[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

function flatten(nodes: TreeNode[], out: string[] = []) {
  for (const node of nodes) {
    if (node.type === "dir") flatten(node.children ?? [], out);
    else out.push(node.path);
  }
  return out;
}

/** How often the tree is re-read. A run writing files changes it several times a
 *  second, so a live run is polled briskly; the rest of the time it still moves
 *  — the user edits in their own editor, a build drops files — just far more
 *  slowly. */
const LIVE_INTERVAL = 4_000;
const IDLE_INTERVAL = 15_000;

/** Fetch the tree for the project folder, re-reading it on an interval.
 *
 *  Polling rather than a one-shot read because the folder is shared: a run
 *  writes into it while the user is looking at it, and a panel that only reloads
 *  on mount would show the folder as it stood before the agent touched it.
 *
 *  Idle polling is paused while the tab is hidden and re-read on the way back —
 *  a background tab walking the tree every fifteen seconds buys nobody
 *  anything, and returning to a stale panel is the thing being fixed. */
export function useWorkspace({ live = false }: { live?: boolean } = {}): WorkspaceState {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    const read = async (quiet: boolean) => {
      if (!quiet) setLoading(true);
      try {
        const response = await fetch("/api/files", { cache: "no-store" });
        const body = await response.json();
        if (stale) return;
        if (body.error) { setError(body.error); return; }
        setError(null);
        setRoot(body.root ?? null);
        setTree(body.tree ?? []);
        setTruncated(Boolean(body.truncated));
      } catch (cause) {
        if (!stale) setError(String(cause));
      } finally {
        if (!stale) setLoading(false);
      }
    };
    void read(false);
    // A quiet refresh either way: the tree updates under the user without a
    // spinner flashing over a panel they are reading.
    const timer = setInterval(() => {
      if (!live && document.visibilityState === "hidden") return;
      void read(true);
    }, live ? LIVE_INTERVAL : IDLE_INTERVAL);
    // Coming back to the tab is the one moment a stale tree is certain and
    // waiting out the rest of the interval is most visible.
    const onVisible = () => { if (document.visibilityState === "visible") void read(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stale = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nonce, live]);

  const paths = useMemo(() => flatten(tree), [tree]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { root, tree, paths, truncated, loading, error, reload };
}
