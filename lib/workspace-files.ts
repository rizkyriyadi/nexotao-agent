import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { expandHome, resolveWithin } from "./paths";
import { extractFileText } from "./extract";
import { getActiveProject } from "./store";

/** Directories never worth showing, kept deliberately shorter than the agent's
 *  own skip list. `dist` and `build` are omitted here: a project that checks its
 *  build output in has every right to see it, and the ones that don't have it in
 *  `.gitignore` already — which the walk below honours by listing the folder but
 *  not descending into it. That is a fact about this repository rather than a
 *  guess from a folder name. */
const SKIP = new Set(["node_modules", ".git", ".next", ".cache"]);

/** A ceiling on how many entries one tree read returns. A monorepo can hold
 *  hundreds of thousands of files; sending them all would stall the browser and
 *  buy nothing, because nobody scrolls that far. When the walk hits the cap the
 *  response says so rather than pretending the tree ended there. */
const NODE_BUDGET = 6_000;
/** Ceiling on what a single `git` invocation may hand back. Well above any
 *  real repository's ignore or status listing, and short of anything that
 *  threatens the process. */
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Text is capped well below what a browser will render happily; images are
 *  inlined as data URLs, so their cap is about response size, not readability. */
const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 6 * 1024 * 1024;
/** PDFs are decompressed and re-copied by the extractor, so the ceiling is lower
 *  than the raw bytes suggest. */
const PDF_LIMIT = 12 * 1024 * 1024;

export type TreeNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  /** Single-letter git status (M, A, D, R, U for untracked). */
  status?: string;
  /** True for the directory itself when a descendant is modified. */
  dirty?: boolean;
  ignored?: boolean;
  children?: TreeNode[];
};

/** The folder the panel shows. There is exactly one of these — the project the
 *  user has open — and the shape survives only because three API routes still
 *  echo it to the client. */
export type WorkspaceRoot = {
  id: string;
  label: string;
  detail: string;
  path: string;
};

/** Identity of the bytes we read, echoed back on save.
 *
 *  An agent may be writing the same file while it sits open in the editor. Size
 *  and mtime together are enough to notice that: if either moved, the buffer on
 *  screen is no longer an edit of what is on disk, and saving it would silently
 *  drop whatever landed in between. */
export type FileVersion = { size: number; mtimeMs: number };

type PreviewBase = { path: string; name: string; size: number; mtimeMs: number };

export type FilePreview =
  | ({ kind: "text"; language: string; text: string; truncated: boolean } & PreviewBase)
  | ({ kind: "markdown"; text: string; truncated: boolean } & PreviewBase)
  | ({ kind: "image"; dataUrl: string } & PreviewBase)
  | ({ kind: "pdf"; text: string; ok: boolean } & PreviewBase)
  | ({ kind: "binary"; reason: string } & PreviewBase);

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
};

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".css": "css", ".scss": "scss", ".html": "html", ".py": "python", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cpp": "cpp",
  ".cs": "csharp", ".php": "php", ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".sql": "sql", ".yml": "yaml",
  ".yaml": "yaml", ".toml": "toml", ".xml": "xml", ".env": "bash", ".lock": "text", ".txt": "text",
};

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);

function run(cmd: string, args: string[], cwd: string) {
  return new Promise<string>((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    // Capped like every other spawn in the app. Git's output here is normally
    // tens of kilobytes, but "normally" is doing the work in that sentence: a
    // repo with no .gitignore and a generated build tree is the case where this
    // is read at all, and an unbounded accumulator has no answer for it.
    let out = "";
    child.stdout.on("data", (chunk) => {
      if (out.length < GIT_OUTPUT_LIMIT) out += String(chunk).slice(0, GIT_OUTPUT_LIMIT - out.length);
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

/** Resolve `sub` inside `root`, refusing anything that escapes it.
 *
 *  `resolveWithin` compares the *lexical* path, which a symlink defeats: a link
 *  at `docs/secrets -> /etc` resolves lexically inside the project and really
 *  points anywhere. The panel reads whatever path it is handed straight from an
 *  HTTP query, so the real path has to be checked too. */
async function safeResolve(root: string, sub: string) {
  const abs = resolveWithin(root, sub || ".");
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const real = await fs.realpath(abs).catch(() => abs);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error("Path escapes the workspace");
  }
  return abs;
}

/** Git's own view of what is ignored, asked once for the whole tree.
 *
 *  Asked per-directory this would be one process spawn per folder. Asked once
 *  it is a single call whose output also tells the walk which directories not
 *  to descend into — a `.gitignore`d build folder can hold more files than the
 *  rest of the repository put together. */
async function ignoredPaths(root: string) {
  const out = await run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], root);
  const files = new Set<string>();
  const dirs: string[] = [];
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    if (entry.endsWith("/")) dirs.push(entry.slice(0, -1));
    else files.add(entry);
  }
  return { files, dirs: new Set(dirs) };
}

/** Working-tree status per path, as single letters. Untracked files report `U`
 *  rather than git's `??` because one column reads better in a tree. */
async function statusMap(root: string) {
  const out = await run("git", ["status", "--porcelain", "-z"], root);
  const map = new Map<string, string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename is emitted as `R  new\0old`; the extra field is not an entry.
    if (code[0] === "R" || code[0] === "C") i++;
    map.set(file, code.trim() === "??" ? "U" : (code.trim()[0] ?? "M"));
  }
  return map;
}

/** Read the whole visible tree in one pass, annotated with git state.
 *
 *  Returned as a single nested structure rather than fetched per-folder on
 *  expand: the panel searches across every path, and a search that only covers
 *  the folders you happen to have opened is worse than no search. */
export async function readTree(root: string): Promise<{ tree: TreeNode[]; truncated: boolean }> {
  const [ignored, status] = await Promise.all([ignoredPaths(root), statusMap(root)]);
  let budget = NODE_BUDGET;
  let truncated = false;

  async function walk(dir: string, prefix: string): Promise<TreeNode[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    const sorted = entries
      .filter((e) => !SKIP.has(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

    for (const entry of sorted) {
      if (budget <= 0) { truncated = true; break; }
      budget--;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      const isIgnored = isDir ? ignored.dirs.has(relative) : ignored.files.has(relative);

      if (isDir) {
        // An ignored directory is listed but not descended into. Its contents
        // are build output by definition, and they are what makes a tree walk
        // expensive in the first place.
        const children = isIgnored ? [] : await walk(path.join(dir, entry.name), relative);
        const dirty = children.some((c) => c.status || c.dirty);
        nodes.push({ name: entry.name, path: relative, type: "dir", children, ignored: isIgnored || undefined, dirty: dirty || undefined });
      } else {
        let size: number | undefined;
        try { size = (await fs.stat(path.join(dir, entry.name))).size; } catch { /* vanished mid-walk */ }
        nodes.push({ name: entry.name, path: relative, type: "file", size, status: status.get(relative), ignored: isIgnored || undefined });
      }
    }
    return nodes;
  }

  return { tree: await walk(root, ""), truncated };
}

/** The folder the panel shows: the project the user has open, and nothing else.
 *
 *  This used to return a list — the project plus one entry per run writing into
 *  its own worktree — and picking between them was the whole reason the panel
 *  read as a different folder per task, with the terminal opening somewhere the
 *  user had never been. Runs write into the project folder now, so there is one
 *  answer to "where are my files?" and it never changes. */
export async function listRoots(): Promise<WorkspaceRoot[]> {
  const project = await getActiveProject();
  if (!project) return [];
  const root = expandHome(project.path);
  return [{ id: "project", label: project.name || path.basename(root), detail: root, path: root }];
}

export async function activeRoot(): Promise<WorkspaceRoot | null> {
  return (await listRoots())[0] ?? null;
}

/** Kept as the entry point for requests that name a root, because three API
 *  routes still pass one through. Every id now resolves to the same folder. */
export async function resolveRoot(_id: string | null): Promise<WorkspaceRoot | null> {
  return activeRoot();
}

/** Heuristic that decides whether a file can be shown as text. A NUL byte in
 *  the first few KB is the same test `git diff` uses, and it is right far more
 *  often than trusting the extension. */
function looksBinary(buffer: Buffer) {
  const window = buffer.subarray(0, 8_000);
  return window.includes(0);
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read one file for display: markdown rendered, PDFs extracted to text, images
 *  inlined, code as text with a language hint, anything else declared binary
 *  rather than dumped as mojibake. */
export async function readPreview(root: string, sub: string): Promise<FilePreview> {
  const abs = await safeResolve(root, sub);
  const stat = await fs.stat(abs);
  const name = path.basename(abs);
  const extension = path.extname(abs).toLowerCase();
  const base = { path: sub, name, size: stat.size, mtimeMs: stat.mtimeMs };

  if (stat.isDirectory()) return { kind: "binary", ...base, reason: "This is a folder." };

  if (IMAGE_TYPES[extension]) {
    if (stat.size > IMAGE_LIMIT) return { kind: "binary", ...base, reason: `Image is ${humanSize(stat.size)} — too large to preview.` };
    const bytes = await fs.readFile(abs);
    return { kind: "image", ...base, dataUrl: `data:${IMAGE_TYPES[extension]};base64,${bytes.toString("base64")}` };
  }

  if (extension === ".pdf") {
    // Gated like the image branch above. Without this a PDF was read whole into
    // memory and then handed to the extractor, which builds its own copy — the
    // one preview path with no ceiling at all.
    if (stat.size > PDF_LIMIT) return { kind: "binary", ...base, reason: `PDF is ${humanSize(stat.size)} — too large to preview.` };
    const bytes = await fs.readFile(abs);
    const result = await extractFileText(name, new Uint8Array(bytes));
    return { kind: "pdf", ...base, text: result.text.slice(0, TEXT_LIMIT), ok: result.ok };
  }

  // A file past the cap is shown truncated rather than refused: the top of a
  // huge log or a generated bundle is usually the part someone opened it for.
  const handle = await fs.open(abs, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
    await handle.read(buffer, 0, buffer.length, 0);
  } finally {
    await handle.close();
  }
  if (looksBinary(buffer)) return { kind: "binary", ...base, reason: "Binary file — no text preview." };

  const text = buffer.toString("utf8");
  const truncated = stat.size > TEXT_LIMIT;
  if (MARKDOWN.has(extension)) return { kind: "markdown", ...base, text, truncated };
  return { kind: "text", ...base, language: LANGUAGES[extension] ?? (extension ? extension.slice(1) : "text"), text, truncated };
}

/** Save an edited text file back to disk.
 *
 *  Two things can go wrong that the user cannot see, so both are refused rather
 *  than handled optimistically:
 *
 *  - **The file changed underneath.** An agent run writes into the same tree the
 *    editor is reading. If size or mtime moved since the preview was taken, the
 *    buffer on screen is an edit of bytes that no longer exist, and writing it
 *    would erase the agent's work with no trace. The caller sends back the
 *    version it read and gets a conflict instead.
 *  - **The file was only partially read.** A file past `TEXT_LIMIT` is previewed
 *    truncated. Saving that buffer would delete everything past the cap, which
 *    looks like a successful save right up until the missing half is noticed.
 *
 *  Only files that were previewable as text can be written: this endpoint exists
 *  to edit code, config and notes, not to let arbitrary bytes be POSTed over a
 *  PDF or a PNG. */
export async function writeFile(
  root: string,
  sub: string,
  text: string,
  expected: FileVersion | null,
): Promise<{ ok: true; version: FileVersion } | { ok: false; conflict: string }> {
  const abs = await safeResolve(root, sub);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) return { ok: false, conflict: "That is a folder, not a file." };
  if (stat.size > TEXT_LIMIT) {
    return { ok: false, conflict: `This file is ${humanSize(stat.size)} — only the first ${humanSize(TEXT_LIMIT)} was read, so saving would truncate it.` };
  }

  const extension = path.extname(abs).toLowerCase();
  if (IMAGE_TYPES[extension] || extension === ".pdf") {
    return { ok: false, conflict: "Only text files can be edited here." };
  }

  if (expected && (expected.size !== stat.size || Math.abs(expected.mtimeMs - stat.mtimeMs) > 1)) {
    return { ok: false, conflict: "This file changed on disk since you opened it — reload it before saving, or your edit would overwrite that change." };
  }

  // Written through a temporary file in the same directory and renamed into
  // place: a half-written source file is worse than an unsaved one, and a crash
  // mid-write is exactly how you get one. `rename` within a directory is atomic.
  const temporary = path.join(path.dirname(abs), `.${path.basename(abs)}.nexotao-${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, text, "utf8");
    await fs.rename(temporary, abs);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
  const after = await fs.stat(abs);
  return { ok: true, version: { size: after.size, mtimeMs: after.mtimeMs } };
}

/** Every file path in a tree, flattened — the corpus the `@` mention picker
 *  searches. Directories are dropped: mentioning a folder tells the agent
 *  nothing it can read. */
export function flattenPaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "dir") walk(node.children ?? []);
      else out.push(node.path);
    }
  };
  walk(tree);
  return out;
}
