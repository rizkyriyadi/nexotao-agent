"use client";

/* One reader of the workspace tree, shared by the dock and the composer's `@`
   picker. Two independent fetchers would walk the same folders twice and, worse,
   drift: mentioning a file the tree beside you does not list is the kind of
   inconsistency that makes a panel feel broken. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TreeNode, WorkspaceRoot } from "@/lib/workspace-files";

export type WorkspaceState = {
  roots: WorkspaceRoot[];
  root: WorkspaceRoot | null;
  tree: TreeNode[];
  paths: string[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
  choose: (id: string) => void;
};

function flatten(nodes: TreeNode[], out: string[] = []) {
  for (const node of nodes) {
    if (node.type === "dir") flatten(node.children ?? [], out);
    else out.push(node.path);
  }
  return out;
}

/** Fetch the tree for one root, re-fetching on an interval while a run is live.
 *
 *  `live` is the honest trigger: a run writing files is the only thing that
 *  changes this tree without the user touching anything, and polling a folder
 *  nobody is writing to is pure cost. */
export function useWorkspace({ live = false }: { live?: boolean } = {}): WorkspaceState {
  const [roots, setRoots] = useState<WorkspaceRoot[]>([]);
  const [root, setRoot] = useState<WorkspaceRoot | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    const read = async (quiet: boolean) => {
      if (!quiet) setLoading(true);
      try {
        const response = await fetch(`/api/files${wanted ? `?root=${encodeURIComponent(wanted)}` : ""}`, { cache: "no-store" });
        const body = await response.json();
        if (stale) return;
        if (body.error) { setError(body.error); return; }
        setError(null);
        setRoots(body.roots ?? []);
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
    // A quiet refresh while the agent works: the tree updates under the user
    // without a spinner flashing over a panel they are reading.
    const timer = live ? setInterval(() => void read(true), 4000) : null;
    return () => { stale = true; if (timer) clearInterval(timer); };
  }, [wanted, nonce, live]);

  const paths = useMemo(() => flatten(tree), [tree]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const choose = useCallback((id: string) => setWanted(id), []);

  return { roots, root, tree, paths, truncated, loading, error, reload, choose };
}
