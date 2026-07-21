import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { resolveWithin, rel } from "./paths";
import { webFetch, webSearch } from "./websearch";
import { getConfig } from "./config";

const pexec = promisify(exec);
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache"]);
const MUTATING = new Set(["write_file", "edit_file", "bash"]);

export function isMutating(name: string) {
  return MUTATING.has(name);
}

/** Anthropic tool definitions passed to the model. */
export const TOOL_DEFS = [
  {
    name: "list_dir",
    description: "List files and folders at a path (relative to the project root). Use '.' for the root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, relative to project root" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file's contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exactly one occurrence of old_str with new_str in a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the project root. Use for installs, tests, git, running the app.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regular expression across the project.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string", description: "optional subdir" } },
      required: ["pattern"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for up-to-date information. Returns a list of results (title, URL, snippet). Follow up with web_fetch to read a promising result.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page (or raw URL) and return its readable text content. Use for docs, articles, GitHub files, API references, etc.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full URL to fetch" } },
      required: ["url"],
    },
  },
] as const;

export type ToolOut = { ok: boolean; output: string; display?: string; kind?: "bash" | "write"; file?: string; content?: string };

export async function executeTool(name: string, input: any, root: string): Promise<ToolOut> {
  try {
    switch (name) {
      case "list_dir": {
        const abs = resolveWithin(root, input.path ?? ".");
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries
          .filter((e) => !SKIP.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return { ok: true, output: lines.join("\n") || "(empty)", display: `${lines.length} items` };
      }
      case "read_file": {
        const abs = resolveWithin(root, input.path);
        const buf = await fs.readFile(abs, "utf8");
        const capped = buf.length > 100_000 ? buf.slice(0, 100_000) + "\n… (truncated)" : buf;
        return { ok: true, output: capped, display: `${buf.split("\n").length} lines` };
      }
      case "write_file": {
        const abs = resolveWithin(root, input.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const content = String(input.content ?? "");
        await fs.writeFile(abs, content, "utf8");
        return {
          ok: true,
          output: `Wrote ${rel(root, abs)} (${content.split("\n").length} lines).`,
          display: `+${content.split("\n").length}`,
          kind: "write",
          file: rel(root, abs),
          content,
        };
      }
      case "edit_file": {
        const abs = resolveWithin(root, input.path);
        const cur = await fs.readFile(abs, "utf8");
        const old = String(input.old_str ?? "");
        const count = cur.split(old).length - 1;
        if (count === 0) return { ok: false, output: `old_str not found in ${rel(root, abs)}.` };
        if (count > 1) return { ok: false, output: `old_str matches ${count} times — make it unique.` };
        const next = cur.replace(old, String(input.new_str ?? ""));
        await fs.writeFile(abs, next, "utf8");
        return {
          ok: true,
          output: `Edited ${rel(root, abs)}.`,
          display: "edited",
          kind: "write",
          file: rel(root, abs),
          content: next,
        };
      }
      case "bash": {
        const command = String(input.command ?? "");
        try {
          const { stdout, stderr } = await pexec(command, { cwd: root, timeout: 60_000, maxBuffer: 2_000_000 });
          const out = (stdout + (stderr ? `\n${stderr}` : "")).trim();
          return { ok: true, output: out || "(no output)", display: "exit 0", kind: "bash" };
        } catch (e: any) {
          const out = ((e.stdout ?? "") + "\n" + (e.stderr ?? e.message ?? "")).trim();
          return { ok: false, output: out || String(e), display: `exit ${e.code ?? 1}`, kind: "bash" };
        }
      }
      case "grep": {
        const base = resolveWithin(root, input.path ?? ".");
        const re = new RegExp(input.pattern, "i");
        const hits: string[] = [];
        await walk(base, root, (file, text) => {
          text.split("\n").forEach((line, i) => {
            if (hits.length < 60 && re.test(line)) hits.push(`${rel(root, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
          });
        });
        return { ok: true, output: hits.join("\n") || "no matches", display: `${hits.length} matches` };
      }
      case "web_search": {
        const cfg = await getConfig();
        const r = await webSearch(String(input.query ?? ""), cfg.searchApiKey);
        return { ok: r.ok, output: r.text, display: r.ok ? `${r.count} results` : "no results" };
      }
      case "web_fetch": {
        const r = await webFetch(String(input.url ?? ""));
        return { ok: r.ok, output: r.text, display: r.ok ? "fetched" : "failed" };
      }
      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { ok: false, output: String(e?.message ?? e) };
  }
}

async function walk(dir: string, root: string, onFile: (file: string, text: string) => void, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, onFile, depth + 1);
    else if (e.isFile()) {
      try {
        const stat = await fs.stat(full);
        if (stat.size > 1_000_000) continue;
        const text = await fs.readFile(full, "utf8");
        onFile(full, text);
      } catch {
        /* binary / unreadable */
      }
    }
  }
}

/** Shallow tree for the Files panel. */
export async function listTree(root: string, sub = "."): Promise<{ name: string; type: "dir" | "file" }[]> {
  const abs = resolveWithin(root, sub);
  if (!existsSync(abs)) return [];
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => !SKIP.has(e.name))
    .map((e) => ({ name: e.name, type: e.isDirectory() ? ("dir" as const) : ("file" as const) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}
