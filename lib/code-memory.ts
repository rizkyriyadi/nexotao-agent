// The code-intelligence layer: a thin, total boundary around the
// `codebase-memory-mcp` CLI.
//
// Every agent run opens by being told to call graph_query "before reading files".
// Until now that only reached the work-history graph (lib/graphify.ts) — the code
// half pointed at a producer that no longer exists, so the answer never mentioned
// a single symbol. This module supplies that half: symbols, call graphs and source
// snippets from a tree-sitter index the app keeps fresh on its own.
//
// Two rules govern everything here.
//
//   1. Nothing throws. The binary is optional and absent on a fresh install, so
//      every entry point returns null/false on every failure — missing binary,
//      non-zero exit, `isError`, timeout, unparseable output. An error on the
//      first tool call of a run is the first thing the user sees, and there is
//      nothing they could do about it.
//   2. One index per project, named by us. A folder can be opened at a
//      subdirectory, or as one of the user's own linked worktrees; indexing it
//      as given would key a second multi-MB index to the same source under a
//      different path. So we always index the canonical repo root under an
//      explicit `nexotao-idx-<id>` name, which also makes teardown unambiguous:
//      that prefix is ours, and an index the user built by hand for their own
//      CLI use is never touched.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./paths";
import { killTree } from "./process-tree";

/** npm package providing the CLI. Never a dependency of this app — see the
 *  packaging test in tests/code-memory.test.ts. */
export const CLI_PACKAGE = "codebase-memory-mcp";
/** Our namespace inside the shared cache. Everything we create and everything we
 *  are allowed to delete carries this prefix. */
export const INDEX_PREFIX = "nexotao-idx-";
/** Where the one-click install puts the CLI: a Nexotao-owned prefix, because
 *  `npm prefix -g` is commonly root-owned and `npm i -g` would need sudo. */
export const TOOLS_DIR = path.join(os.homedir(), ".nexotao", "tools");

export type IndexMode = "full" | "moderate" | "fast";

const TIMEOUT = { detect: 10_000, query: 20_000, index: 600_000, drop: 30_000 } as const;

/** Spawn boundary, injectable so tests never invoke the real binary. Resolves —
 *  never rejects — with `code: 127` when the binary is absent. */
export type CliExec = (
  args: string[],
  stdin: string,
  opts: { signal?: AbortSignal; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type CliDeps = { exec?: CliExec; signal?: AbortSignal };

export type CodeIndexStatus = { project: string; nodes: number; edges: number; indexedAt: number };
export type CodeHit = { name: string; kind: string; file: string; startLine: number; endLine: number };
export type CodeTraceHop = { name: string; qualifiedName: string; hop: number; direction: "caller" | "callee" };
export type CodeTrace = { fn: string; hops: CodeTraceHop[] };
export type CodeSnippet = {
  name: string; qualifiedName: string; kind: string; file: string;
  startLine: number; endLine: number; source: string;
  complexity?: number; cognitive?: number; callers?: number; callees?: number; signature?: string;
};

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

// The CLI takes its arguments as a JSON object on stdin. runCommand (lib/tools.ts)
// cannot be reused for this: it spawns with stdio ["ignore", …], so stdin is
// closed before we could write. argv form with shell:false, so an arbitrary
// question string never needs escaping.
function spawnCli(bin: string): CliExec {
  return (args, stdin, opts) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (r: { code: number; stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", stop);
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      } catch {
        return resolve({ code: 127, stdout: "", stderr: "spawn failed" });
      }
      let stdout = "";
      let stderr = "";
      const cap = (chunk: Buffer, into: "out" | "err") => {
        const text = chunk.toString("utf8");
        if (into === "out") { if (stdout.length < 2_000_000) stdout += text.slice(0, 2_000_000 - stdout.length); }
        else if (stderr.length < 64_000) stderr += text.slice(0, 64_000 - stderr.length);
      };
      child.stdout?.on("data", (c: Buffer) => cap(c, "out"));
      child.stderr?.on("data", (c: Buffer) => cap(c, "err"));
      // The indexer forks workers; killing only the direct child orphans them.
      // On Windows a bare pid did exactly that — see lib/process-tree.
      const stop = () => killTree(child.pid, () => child.kill("SIGTERM"));
      const timer = setTimeout(stop, opts.timeoutMs);
      opts.signal?.addEventListener("abort", stop, { once: true });
      // ENOENT (binary absent) is the normal state on a fresh install, so it
      // resolves into the same shape as any other failure rather than rejecting.
      child.once("error", () => done({ code: 127, stdout: "", stderr: "spawn failed" }));
      child.once("close", (code, killedBy) => done({ code: code ?? (killedBy ? 124 : 1), stdout, stderr }));
      try {
        child.stdin?.on("error", () => { /* the CLI may exit before reading */ });
        child.stdin?.end(stdin);
      } catch { /* stdin already closed */ }
    });
}

export type CliResult = { ok: boolean; data: unknown | null; error: string | null };

/**
 * Parse one CLI response. Pure and total — exported for tests.
 *
 * Structured output arrives on stdout and `level=…` narration on stderr, but the
 * two have been observed to interleave during indexing, and a bare JSON.parse of
 * a narrated stream throws — which a caller would then report as "no results"
 * from a perfectly healthy index. So narration lines are dropped first.
 *
 * Failure is signalled by `isError: true` **with exit code 0**: querying a
 * project that was never indexed returns exactly that. An exit-code-only check
 * reads it as success and hands the error text back as data.
 */
export function parseCliOutput(stdout: string): CliResult {
  const body = String(stdout ?? "")
    .split("\n")
    .filter((line) => !/^level=(info|warn|error|debug)\b/.test(line.trim()))
    .join("\n")
    .trim();
  if (!body) return { ok: false, data: null, error: "empty output" };
  let envelope: any;
  try {
    envelope = JSON.parse(body);
  } catch {
    return { ok: false, data: null, error: "unparseable output" };
  }
  if (!envelope || typeof envelope !== "object") return { ok: false, data: null, error: "unexpected output" };

  let data: unknown = envelope.structuredContent ?? null;
  if (data == null && Array.isArray(envelope.content)) {
    const text = envelope.content.find((c: any) => c?.type === "text")?.text;
    if (typeof text === "string") {
      try { data = JSON.parse(text); } catch { data = text; }
    }
  }
  if (envelope.isError === true) {
    const message = typeof data === "string" ? data
      : Array.isArray(envelope.content) ? String(envelope.content[0]?.text ?? "cli error")
      : "cli error";
    return { ok: false, data: null, error: message.slice(0, 500) };
  }
  return { ok: true, data, error: null };
}

/** Resolve the CLI: our managed prefix first, then PATH. Null = no code layer. */
export async function resolveCli(): Promise<string> {
  const managed = path.join(TOOLS_DIR, "node_modules", ".bin", CLI_PACKAGE);
  try {
    await fs.access(managed);
    return managed;
  } catch { /* fall through to PATH */ }
  // The bare name, deliberately: whether it is on PATH is not knowable without
  // walking PATH ourselves, and spawn already answers it — ENOENT arrives as
  // `code: 127`, the same "absent" shape every caller handles.
  return CLI_PACKAGE;
}

/** Run one CLI tool. Returns null on every failure, including an absent binary. */
async function callCli(tool: string, input: Record<string, unknown>, timeoutMs: number, deps?: CliDeps): Promise<unknown | null> {
  try {
    const exec = deps?.exec ?? spawnCli(await resolveCli());
    const r = await exec(["cli", "--json", tool], JSON.stringify(input), { signal: deps?.signal, timeoutMs });
    if (r.code !== 0) return null;
    const parsed = parseCliOutput(r.stdout);
    return parsed.ok ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index identity
// ---------------------------------------------------------------------------

/** The one name this app ever indexes a project under. Pure. */
export function codeIndexName(projectId: string): string {
  return `${INDEX_PREFIX}${projectId}`;
}

// What we index is the repository that owns a root, not the root itself. Cached
// because graph_query is the first call of every run and resolving it must not
// mean a git spawn each time.
const canonicalRoots = new Map<string, string>();

/**
 * Map any root to the canonical repo root. A run's root is now the project
 * folder itself, so this is usually the identity — but the folder a user opens
 * can still be a linked worktree of their own, or a subdirectory of a repo, and
 * indexing it as if it were its own repository would build a second index of the
 * same source under a different key. `git rev-parse --git-common-dir` points at
 * the *owning* repository's `.git` in both cases, which is precisely the
 * distinction we need. Falls back to the input when git is absent or the path is
 * not a repo.
 */
export async function canonicalRoot(root: string, deps?: { exec?: CliExec }): Promise<string> {
  const start = expandHome(root);
  const cached = canonicalRoots.get(start);
  if (cached) return cached;
  const resolved = await resolveCanonicalRoot(start, deps);
  canonicalRoots.set(start, resolved);
  return resolved;
}

function gitExec(): CliExec {
  return (args, _stdin, opts) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (r: { code: number; stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("git", args.slice(1), { cwd: args[0], stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return resolve({ code: 127, stdout: "", stderr: "" });
      }
      let stdout = "";
      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, opts.timeoutMs);
      child.once("error", () => done({ code: 127, stdout: "", stderr: "" }));
      child.once("close", (code) => done({ code: code ?? 1, stdout, stderr: "" }));
    });
}

async function resolveCanonicalRoot(start: string, deps?: { exec?: CliExec }): Promise<string> {
  try {
    const exec = deps?.exec ?? gitExec();
    const r = await exec([start, "rev-parse", "--path-format=absolute", "--git-common-dir"], "", { timeoutMs: 10_000 });
    const gitDir = r.code === 0 ? r.stdout.trim() : "";
    if (!gitDir) return start;
    // …/repo/.git → …/repo. A bare repo has no working tree to index, so it is
    // left as-is and the index simply comes out empty.
    const base = path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
    return base || start;
  } catch {
    return start;
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Is the CLI usable? Never throws; false means "no code layer", not "broken". */
export async function detectCodeMemory(deps?: CliDeps): Promise<boolean> {
  try {
    const exec = deps?.exec ?? spawnCli(await resolveCli());
    const r = await exec(["--version"], "", { signal: deps?.signal, timeoutMs: TIMEOUT.detect });
    return r.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Index one project. Always indexes the canonical repo root under our own name,
 * whatever root the caller happened to have — a caller passing a subdirectory,
 * or a worktree of the user's own, still reads and writes the project's single
 * index.
 */
export async function indexProject(
  projectId: string,
  root: string,
  opts: CliDeps & { mode?: IndexMode } = {},
): Promise<CodeIndexStatus | null> {
  const repoPath = await canonicalRoot(root);
  const data = await callCli("index_repository", {
    repo_path: repoPath,
    mode: opts.mode ?? "fast",
    name: codeIndexName(projectId),
  }, TIMEOUT.index, opts) as any;
  if (!data || typeof data !== "object") return null;
  return {
    project: String(data.project ?? codeIndexName(projectId)),
    nodes: Number(data.nodes ?? 0),
    edges: Number(data.edges ?? 0),
    indexedAt: Date.now(),
  };
}

/**
 * Read a project's existing index without touching it. Cheap (~30 ms — it reads
 * the SQLite header, it does not walk the tree), so a page load can ask for the
 * counts rather than having to remember what the last build reported.
 * `null` means "no index for this project", which is also what an unindexed
 * project's `isError` response comes back as.
 */
export async function codeIndexStatus(projectId: string, deps?: CliDeps): Promise<CodeIndexStatus | null> {
  const name = codeIndexName(projectId);
  const data = await callCli("index_status", { project: name }, TIMEOUT.query, deps) as any;
  if (!data || typeof data !== "object" || typeof data.nodes !== "number") return null;
  return {
    project: String(data.project ?? name),
    nodes: Number(data.nodes ?? 0),
    edges: Number(data.edges ?? 0),
    indexedAt: 0, // the CLI reports no timestamp; the caller knows when it asked
  };
}

// Two indexers writing one SQLite file is how a `.db.corrupt` appears in the
// cache. Concurrent callers share a single spawn, and a call arriving just after
// one finished is a no-op — the triggers deliberately overlap (run start fires
// moments after project open), and re-walking the tree each time would be waste.
const refreshChains = new Map<string, { at: number; promise: Promise<CodeIndexStatus | null> }>();

/** Refresh a project's index, coalescing bursts. Safe to call from any trigger. */
export function refreshCodeIndex(
  projectId: string,
  root: string,
  opts: CliDeps & { mode?: IndexMode; minIntervalMs?: number } = {},
): Promise<CodeIndexStatus | null> {
  const minInterval = opts.minIntervalMs ?? 5_000;
  const inflight = refreshChains.get(projectId);
  if (inflight && Date.now() - inflight.at < minInterval) return inflight.promise;

  const entry = { at: Date.now(), promise: Promise.resolve<CodeIndexStatus | null>(null) };
  entry.promise = indexProject(projectId, root, opts)
    .catch(() => null)
    .then((status) => {
      // Stamp completion, so the debounce window measures from when the index
      // actually finished rather than from when the burst started.
      const current = refreshChains.get(projectId);
      if (current === entry) current.at = Date.now();
      return status;
    });
  refreshChains.set(projectId, entry);
  return entry.promise;
}

/** Test seam: forget the debounce state. */
export function resetCodeIndexCaches() {
  refreshChains.clear();
  canonicalRoots.clear();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Symbols matching a plain-language question. Null = no code layer. */
export async function searchCode(projectId: string, query: string, limit = 8, deps?: CliDeps): Promise<CodeHit[] | null> {
  const data = await callCli("search_graph", { project: codeIndexName(projectId), query, limit }, TIMEOUT.query, deps) as any;
  const rows = data?.results ?? data?.semantic_results;
  if (!Array.isArray(rows)) return null;
  return rows.map((r: any) => ({
    name: String(r?.name ?? ""),
    kind: String(r?.label ?? "Symbol"),
    file: String(r?.file_path ?? ""),
    startLine: Number(r?.start_line ?? 0),
    endLine: Number(r?.end_line ?? 0),
  })).filter((h) => h.name);
}

/** Callers and callees of a function, flattened into hops. Null = no code layer. */
export async function traceCode(
  projectId: string,
  fn: string,
  opts: CliDeps & { depth?: number } = {},
): Promise<CodeTrace | null> {
  const data = await callCli("trace_path", {
    project: codeIndexName(projectId), function_name: fn, direction: "both", depth: opts.depth ?? 3,
  }, TIMEOUT.query, opts) as any;
  if (!data || typeof data !== "object") return null;
  const collect = (rows: unknown, direction: "caller" | "callee"): CodeTraceHop[] =>
    (Array.isArray(rows) ? rows : []).map((r: any) => ({
      name: String(r?.name ?? ""),
      qualifiedName: String(r?.qualified_name ?? r?.name ?? ""),
      hop: Number(r?.hop ?? 1),
      direction,
    })).filter((h) => h.name);
  const hops = [...collect(data.callers, "caller"), ...collect(data.callees, "callee")].sort((a, b) => a.hop - b.hop);
  return { fn: String(data.function ?? fn), hops };
}

/** One symbol's source and complexity. Null = no match or no code layer. */
export async function explainCode(projectId: string, ref: string, deps?: CliDeps): Promise<CodeSnippet | null> {
  const data = await callCli("get_code_snippet", { project: codeIndexName(projectId), qualified_name: ref }, TIMEOUT.query, deps) as any;
  if (!data || typeof data !== "object" || !data.name) return null;
  return {
    name: String(data.name),
    qualifiedName: String(data.qualified_name ?? data.name),
    kind: String(data.label ?? "Symbol"),
    file: String(data.file_path ?? ""),
    startLine: Number(data.start_line ?? 0),
    endLine: Number(data.end_line ?? 0),
    source: String(data.source ?? ""),
    complexity: typeof data.complexity === "number" ? data.complexity : undefined,
    cognitive: typeof data.cognitive === "number" ? data.cognitive : undefined,
    callers: typeof data.callers === "number" ? data.callers : undefined,
    callees: typeof data.callees === "number" ? data.callees : undefined,
    signature: typeof data.signature === "string" ? data.signature : undefined,
  };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Drop a project's index. Only ever names `nexotao-idx-<projectId>`. */
export async function dropCodeIndex(projectId: string, deps?: CliDeps): Promise<boolean> {
  const data = await callCli("delete_project", { project: codeIndexName(projectId) }, TIMEOUT.drop, deps) as any;
  return Boolean(data && (data.status === "deleted" || data.project));
}

/** Where the CLI keeps its SQLite indexes — outside NEXOTAO_DATA_DIR, and shared
 *  with indexes the user built themselves and with unrelated tooling. */
export function codeIndexCacheDir(): string {
  return path.join(os.homedir(), ".cache", CLI_PACKAGE);
}

/**
 * Reclaim our own leftovers from the shared cache: indexes whose project row is
 * gone, and stale corruption markers. Deliberately timid — it only ever removes
 * files matching our `nexotao-idx-` prefix, never a directory, never a `.db`
 * belonging to someone's hand-built index. Deleting one of those would be a far
 * worse bug than the disk it would reclaim.
 */
export async function sweepCodeIndexCache(
  opts: CliDeps & { knownProjectIds?: string[]; now?: number; dir?: string } = {},
): Promise<{ removed: number }> {
  const dir = opts.dir ?? codeIndexCacheDir();
  const now = opts.now ?? Date.now();
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return { removed: 0 };
  }

  let known = opts.knownProjectIds;
  if (!known) {
    try {
      const { listProjects } = await import("./store");
      known = (await listProjects()).map((p) => p.id);
    } catch {
      return { removed: 0 }; // cannot tell ours from live — remove nothing
    }
  }
  const live = new Set(known.map(codeIndexName));

  let removed = 0;
  for (const name of entries) {
    let doomed = false;
    // Fresh corruption is evidence worth keeping around; week-old corruption is
    // just megabytes.
    if (name.endsWith(".db.corrupt")) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        doomed = now - stat.mtimeMs > 7 * 24 * 60 * 60_000;
      } catch { doomed = false; }
    } else if (name.startsWith(INDEX_PREFIX)) {
      const base = name.replace(/\.db(-shm|-wal)?$/, "");
      doomed = base !== name && !live.has(base);
    }
    if (!doomed) continue;
    try { await fs.rm(path.join(dir, name), { force: true }); removed += 1; } catch { /* locked; next boot */ }
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** The command the install route runs, and the one the UI offers to copy for
 *  anyone who would rather run it themselves. */
export const INSTALL_COMMAND = `npm install --prefix ${TOOLS_DIR} --no-audit --no-fund ${CLI_PACKAGE}`;

let installing: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Install the CLI into a Nexotao-owned prefix.
 *
 * Not `npm i -g`: `npm prefix -g` is commonly a root-owned directory, so a
 * global install needs sudo and fails for most users in a way that reads as a
 * bug in this app. ~/.nexotao/tools needs no privileges and is ours to clean up.
 *
 * Single-flight — a double-clicked button must not start two npm processes over
 * the same node_modules — and never throws: a failed install returns the tail of
 * npm's own output, which is the only thing that would help anyone.
 */
export function installCodeMemory(deps?: { exec?: CliExec }): Promise<{ ok: boolean; error?: string }> {
  installing ??= (async () => {
    try {
      await fs.mkdir(TOOLS_DIR, { recursive: true });
      const exec = deps?.exec ?? spawnCli("npm");
      const r = await exec(
        ["install", "--prefix", TOOLS_DIR, "--no-audit", "--no-fund", CLI_PACKAGE],
        "",
        { timeoutMs: 10 * 60_000 },
      );
      if (r.code === 0) return { ok: true };
      const tail = `${r.stderr || r.stdout}`.trim().split("\n").slice(-8).join("\n");
      return { ok: false, error: tail || `npm exited ${r.code}` };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/** Test seam: forget any in-flight install. */
export function resetInstallState() {
  installing = null;
}
