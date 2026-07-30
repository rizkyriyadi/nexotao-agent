"use client";

import type { LucideIcon } from "lucide-react";
import {
  FileText, FilePlus, FileDiff, FolderTree, Globe, Network, Search, Terminal, Wrench,
} from "lucide-react";

/** How a single tool call presents itself in the transcript.
 *
 *  Modelled on claudecodeui's toolConfigs: one entry per tool decides the label,
 *  the icon, the accent colour, which part of the input is the "subject" of the
 *  call, and — for the activity indicator — how to say what is happening right
 *  now in plain English. */
export type ToolPresentation = {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the left accent rail and the icon tint. */
  accent: string;
  iconTint: string;
  /** The one thing this call is about — a path, a command, a query. */
  value: (input: Record<string, unknown>) => string;
  /** Present-tense sentence for the activity indicator ("Reading lib/agent.ts"). */
  verb: (input: Record<string, unknown>) => string;
  /** Presentation of the result body. `none` hides it entirely. */
  body: "terminal" | "diff" | "write" | "list" | "text" | "none";
  /** Render the value in a monospace file/command face. */
  mono?: boolean;
};

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
// Split on both separators: paths reach here from `rel()`, which uses the host's
// separator, so on Windows a `src\app\page.tsx` was shown whole where every
// other platform showed `page.tsx`.
export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** Fallback for tools added to lib/tools.ts that nobody taught the UI about —
 *  a generic row beats a crash or a raw JSON dump. */
const FALLBACK: ToolPresentation = {
  label: "Tool", icon: Wrench, accent: "border-l-line-strong", iconTint: "text-pebble",
  value: (i) => str(i.path ?? i.query ?? i.command ?? ""),
  verb: () => "Working",
  body: "text",
};

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  bash: {
    label: "Run", icon: Terminal, accent: "border-l-lichen-green", iconTint: "text-lichen-green",
    value: (i) => str(i.command),
    verb: (i) => `Running ${short(str(i.command), 48)}`,
    body: "terminal", mono: true,
  },
  read_file: {
    label: "Read", icon: FileText, accent: "border-l-line-strong", iconTint: "text-bark-grey",
    value: (i) => str(i.path),
    verb: (i) => `Reading ${basename(str(i.path))}`,
    body: "text", mono: true,
  },
  write_file: {
    label: "Write", icon: FilePlus, accent: "border-l-electric-indigo", iconTint: "text-electric-indigo",
    value: (i) => str(i.path),
    verb: (i) => `Writing ${basename(str(i.path))}`,
    body: "write", mono: true,
  },
  edit_file: {
    label: "Edit", icon: FileDiff, accent: "border-l-electric-indigo", iconTint: "text-electric-indigo",
    value: (i) => str(i.path),
    verb: (i) => `Editing ${basename(str(i.path))}`,
    body: "diff", mono: true,
  },
  list_dir: {
    label: "List", icon: FolderTree, accent: "border-l-line-strong", iconTint: "text-bark-grey",
    value: (i) => str(i.path) || ".",
    verb: (i) => `Listing ${str(i.path) || "the project root"}`,
    body: "list", mono: true,
  },
  grep: {
    label: "Grep", icon: Search, accent: "border-l-sapphire-link", iconTint: "text-sapphire-link",
    value: (i) => str(i.pattern),
    verb: (i) => `Searching for ${short(str(i.pattern), 40)}`,
    body: "list", mono: true,
  },
  web_search: {
    label: "Search", icon: Globe, accent: "border-l-sapphire-link", iconTint: "text-sapphire-link",
    value: (i) => str(i.query),
    verb: (i) => `Searching the web for ${short(str(i.query), 40)}`,
    body: "text",
  },
  web_fetch: {
    label: "Fetch", icon: Globe, accent: "border-l-sapphire-link", iconTint: "text-sapphire-link",
    value: (i) => str(i.url),
    verb: (i) => `Fetching ${hostOf(str(i.url))}`,
    body: "text", mono: true,
  },
  graph_query: {
    label: "Graph", icon: Network, accent: "border-l-amber", iconTint: "text-amber",
    value: (i) => str(i.question),
    verb: (i) => `Querying the graph for ${short(str(i.question), 40)}`,
    body: "text",
  },
  graph_path: {
    label: "Graph", icon: Network, accent: "border-l-amber", iconTint: "text-amber",
    value: (i) => `${str(i.a)} → ${str(i.b)}`,
    verb: (i) => `Tracing ${str(i.a)} → ${str(i.b)}`,
    body: "text",
  },
  graph_explain: {
    label: "Graph", icon: Network, accent: "border-l-amber", iconTint: "text-amber",
    value: (i) => str(i.id),
    verb: (i) => `Explaining ${str(i.id)}`,
    body: "text",
  },
};

export function presentationFor(name: string): ToolPresentation {
  return TOOL_PRESENTATION[name] ?? { ...FALLBACK, label: name };
}

/** Tool `input` arrives from the stream as `unknown`; normalise once at the edge
 *  so every accessor below can stay unguarded. */
export function toolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function short(value: string, max: number) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return short(url, 40); }
}
