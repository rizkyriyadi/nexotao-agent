"use client";

/* The tree half of the workspace panel: folders, git state, and a filter that
   searches every path rather than only the folders you happen to have open. */

import { memo, useMemo } from "react";
import { ChevronRight, File, FileCode2, FileImage, FileText, FileType2, Folder, FolderOpen } from "lucide-react";
import type { TreeNode } from "@/lib/workspace-files";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|ya?ml|toml|xml)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const DOC = /\.(md|markdown|mdx|txt)$/i;

/** The glyph for one row. Written as a component rather than a `const Icon =`
 *  picked during render: the latter reads to the React compiler as a component
 *  type created on every render, which it rightly refuses. */
function RowIcon({ node, open }: { node: TreeNode; open: boolean }) {
  const className = `size-[13px] shrink-0 ${node.type === "dir" ? "text-pebble" : "text-pebble/80"}`;
  const props = { className, strokeWidth: 1.8 };
  if (node.type === "dir") return open ? <FolderOpen {...props} /> : <Folder {...props} />;
  if (IMAGE.test(node.name)) return <FileImage {...props} />;
  if (/\.pdf$/i.test(node.name)) return <FileType2 {...props} />;
  if (DOC.test(node.name)) return <FileText {...props} />;
  if (CODE.test(node.name)) return <FileCode2 {...props} />;
  return <File {...props} />;
}

/** Git's own colours for working-tree state, as one letter each. Untracked is
 *  `U` rather than git's `??` because a single column reads better in a tree. */
const STATUS_TONE: Record<string, string> = {
  M: "text-amber", A: "text-lichen-green", U: "text-lichen-green",
  D: "text-alarm-red", R: "text-sapphire-link",
};

/** Keep only the nodes whose path matches, plus every ancestor needed to reach
 *  them. Filtering a tree by dropping non-matching leaves alone would orphan the
 *  matches; a folder is kept when anything beneath it survives. */
function filterTree(nodes: TreeNode[], needle: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "dir") {
      const children = filterTree(node.children ?? [], needle);
      if (children.length || node.name.toLowerCase().includes(needle)) out.push({ ...node, children });
    } else if (node.path.toLowerCase().includes(needle)) {
      out.push(node);
    }
  }
  return out;
}

function Row({
  node, depth, expanded, selected, onToggle, onSelect,
}: {
  node: TreeNode; depth: number; expanded: Set<string>; selected: string | null;
  onToggle: (path: string) => void; onSelect: (node: TreeNode) => void;
}) {
  const open = expanded.has(node.path);
  const isSelected = selected === node.path;

  return (
    <>
      <button
        type="button"
        onClick={() => (node.type === "dir" ? onToggle(node.path) : onSelect(node))}
        aria-expanded={node.type === "dir" ? open : undefined}
        aria-current={isSelected || undefined}
        title={node.path}
        style={{ paddingLeft: 8 + depth * 13 }}
        className={`group flex w-full items-center gap-1.5 rounded-lg py-[3px] pr-2 text-left text-[12.5px] transition-colors ${
          isSelected ? "bg-electric-indigo/12 text-charcoal" : "text-bark-grey hover:bg-veil"
        } ${node.ignored ? "opacity-45" : ""}`}
      >
        <ChevronRight
          className={`size-3 shrink-0 text-pebble transition-transform ${open ? "rotate-90" : ""} ${node.type === "dir" ? "" : "invisible"}`}
          strokeWidth={2}
        />
        <RowIcon node={node} open={open} />
        <span className={`min-w-0 flex-1 truncate ${isSelected ? "font-medium" : ""}`}>{node.name}</span>
        {node.status && <span className={`shrink-0 font-mono text-[10px] ${STATUS_TONE[node.status] ?? "text-pebble"}`}>{node.status}</span>}
        {!node.status && node.dirty && <span className="size-1.5 shrink-0 rounded-full bg-amber/70" aria-label="contains changes" />}
      </button>
      {node.type === "dir" && open &&
        (node.children ?? []).map((child) => (
          <Row key={child.path} node={child} depth={depth + 1} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} />
        ))}
    </>
  );
}

function FileTreeImpl({
  tree, query, expanded, selected, onToggle, onSelect,
}: {
  tree: TreeNode[]; query: string; expanded: Set<string>; selected: string | null;
  onToggle: (path: string) => void; onSelect: (node: TreeNode) => void;
}) {
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? filterTree(tree, needle) : tree), [tree, needle]);

  // While filtering, every surviving folder is opened: a search result buried
  // in a collapsed folder is a result the user cannot see.
  const openSet = useMemo(() => {
    if (!needle) return expanded;
    const all = new Set<string>();
    const collect = (nodes: TreeNode[]) => nodes.forEach((n) => { if (n.type === "dir") { all.add(n.path); collect(n.children ?? []); } });
    collect(shown);
    return all;
  }, [needle, expanded, shown]);

  if (!shown.length) {
    return <p className="px-3 py-8 text-center text-[11.5px] text-pebble">{needle ? "No files match that." : "This folder is empty."}</p>;
  }

  return (
    <div className="pb-3">
      {shown.map((node) => (
        <Row key={node.path} node={node} depth={0} expanded={openSet} selected={selected} onToggle={onToggle} onSelect={onSelect} />
      ))}
    </div>
  );
}

export const FileTree = memo(FileTreeImpl);
