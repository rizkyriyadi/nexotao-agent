import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { expandHome, resolveWithin } from "./paths";
import { extractFileText } from "./extract";
import { getActiveProject } from "./store";
import { getDatabase } from "./db/database";
import { ControlPlaneRepositories } from "./db/repositories";

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

/** Text is capped well below what a browser will render happily; images are
 *  inlined as data URLs, so their cap is about response size, not readability. */
const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 6 * 1024 * 1024;

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

export type WorkspaceRoot = {
  id: string;
  label: string;
  detail: string;
  path: string;
  kind: "project" | "worktree";
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
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

/** Whether `commit` is already contained in the repository's current HEAD.
 *
 *  `run` above resolves with whatever reached stdout and ignores the exit code,
 *  which is right for commands read for their output and useless for one asked a
 *  yes/no question — `merge-base --is-ancestor` answers only in its exit status
 *  and prints nothing either way. A repository that has gone missing, or a
 *  commit garbage-collected out of it, exits non-zero too; "not merged" is the
 *  safe reading, since the worst it does is show a notice pointing at a branch. */
function isAncestor(repository: string, commit: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: repository, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
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

/** Runs whose agent is still at the keyboard. Anything else — succeeded, failed,
 *  cancelled — has stopped writing, and its worktree is history rather than a
 *  place to look. The same pair `validate` and `detectOrphans` use, so all three
 *  agree on what "in flight" means. */
const LIVE_RUN_STATUS = new Set(["running", "waiting"]);

/** Work a run finished that never reached the project folder, and where to find
 *  it. `integrate` refuses rather than forcing a merge when the user's own tree
 *  has uncommitted changes or has moved on, which is right — but it leaves the
 *  files somewhere the folder view cannot see. */
export type WorkspaceNotice = { reference: string; branch: string; reason: string };

/** Every folder the panel *could* show: the project itself, plus a worktree for
 *  each run currently writing into one.
 *
 *  Not what the panel displays — `activeRoot` picks that. This list exists so a
 *  preview or save request naming a worktree still resolves while the run that
 *  owns it is finishing, instead of failing the moment the panel moves on.
 *
 *  Liveness is read from the run's heartbeat, never from the workspace row's
 *  own state. That state is set to `active` when the worktree is provisioned and
 *  only advances when a run *commits*, so every run that failed, was cancelled,
 *  or never reached a commit stayed `active` for good — one dead entry per task
 *  ever attempted, all pointing at abandoned checkouts. The heartbeat is the
 *  record of whether anyone is actually writing there. */
export async function listRoots(): Promise<WorkspaceRoot[]> {
  const project = await getActiveProject();
  if (!project) return [];
  const roots: WorkspaceRoot[] = [
    { id: "project", label: project.name || path.basename(expandHome(project.path)), detail: expandHome(project.path), path: expandHome(project.path), kind: "project" },
  ];
  try {
    const database = await getDatabase();
    const repositories = new ControlPlaneRepositories(database);
    for (const workspace of repositories.listWorkspaces(project.id)) {
      const heartbeat = repositories.getHeartbeat(workspace.runId);
      if (!heartbeat || !LIVE_RUN_STATUS.has(heartbeat.status)) continue;
      if (!(await fs.stat(workspace.workspacePath).then((s) => s.isDirectory()).catch(() => false))) continue;
      const issue = repositories.issues.get(workspace.issueId);
      const reference = issue?.identifier || workspace.branch.split("/")[1] || "run";
      roots.push({
        id: workspace.id,
        label: `${reference} · working copy`,
        detail: issue?.title || workspace.branch,
        path: workspace.workspacePath,
        kind: "worktree",
      });
    }
  } catch {
    // The panel is still useful with only the project folder; a control-plane
    // read that fails should not take the whole tree down with it.
  }
  return roots;
}

/** The one folder the panel shows, chosen rather than asked about.
 *
 *  Offering both the project and a per-run working copy made the user pick
 *  between two folders to answer one question — "where are my files?" — and the
 *  answer changed every task, so the panel read as a different folder per task.
 *  It is not: there is one project, and a worktree is a temporary place the
 *  agent writes so a half-finished run cannot disturb the folder the user has
 *  open. That is an implementation detail, and the panel now keeps it as one.
 *
 *  A live run wins because during it the project folder is genuinely stale — the
 *  agent is writing elsewhere, and showing yesterday's files while the user
 *  watches it write is the confusion this panel exists to remove. The moment the
 *  run settles its work has been fast-forwarded into the project, so the project
 *  folder becomes the truthful answer again and the panel returns on its own.
 *  The newest live run is taken when several exist, so the folder tracks the
 *  work the user is watching rather than an older run still winding down. */
export async function activeRoot(): Promise<WorkspaceRoot | null> {
  const roots = await listRoots();
  if (!roots.length) return null;
  const live = roots.filter((r) => r.kind === "worktree");
  return live.length ? live[live.length - 1] : roots[0];
}

/** Whether a finished run's work is still sitting on its branch, unmerged.
 *
 *  Recorded at the moment of refusal by the executor, then confirmed here
 *  against git before it is shown. The record alone would go stale the instant
 *  the user merges by hand and would nag about work that has long since landed;
 *  asking git whether the commit is an ancestor of HEAD is exact, cheap, and
 *  self-clearing. Only reported while the project folder is on screen — during a
 *  run the panel is showing the worktree, where the files are plainly visible. */
export async function pendingWork(): Promise<WorkspaceNotice | null> {
  try {
    const project = await getActiveProject();
    if (!project) return null;
    const database = await getDatabase();
    const repositories = new ControlPlaneRepositories(database);
    const rejected = repositories.listWorkspaces(project.id).filter((w) => w.state === "rejected" && w.commitSha);
    for (const workspace of rejected.reverse()) {
      if (await isAncestor(workspace.repositoryPath, workspace.commitSha!)) continue;
      const issue = repositories.issues.get(workspace.issueId);
      return {
        reference: issue?.identifier || workspace.branch.split("/")[1] || "this run",
        branch: workspace.branch,
        reason: workspace.recoveryNote || "your project folder had changes of its own",
      };
    }
  } catch {
    // A folder view that cannot reach the control plane is still a folder view.
  }
  return null;
}

export async function resolveRoot(id: string | null): Promise<WorkspaceRoot | null> {
  const roots = await listRoots();
  if (!roots.length) return null;
  return roots.find((r) => r.id === id) ?? (await activeRoot());
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
