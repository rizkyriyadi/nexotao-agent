// `nexotao uninstall` — removes Nexotao and everything it created.
//
// The dangerous part of uninstalling this app is invisible: what it leaves
// behind lives *inside the user's own repositories*, not under ~/.nexotao.
//
// Two kinds of litter, from two eras of the app. Runs used to execute in a git
// worktree registered in the user's repository; deleting ~/.nexotao by hand
// pulls those directories out from under git and leaves every affected
// repository with a stranded worktree registry and dangling `nexotao/*`
// branches. Runs now execute in the user's folder directly and record a
// before-picture as a dangling commit under `refs/nexotao/snapshots/<runId>`,
// one per run, visible in `git for-each-ref` and carried along by
// `git push --mirror`.
//
// Both have to be handed back, and anyone uninstalling today may well have
// both. So this is not "delete a folder". It is **release, then delete**, in
// that order, and shipping it as a command is the only way to guarantee the
// order is right.
//
// Deliberately dependency-free and self-contained: `package.json` publishes
// only ["bin", ".next", "public", "next.config.mjs"], so `lib/` does not exist
// on an installed copy and none of its helpers can be imported here. Every
// export takes an injectable `deps` so the tests never touch a real home
// directory, a real cache, or npm.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const CONFIRMATION = "UNINSTALL";
export const INDEX_PREFIX = "nexotao-idx-";
export const CACHE_PACKAGE = "codebase-memory-mcp";
export const PACKAGE_NAME = "nexotao";
/** Only branches we created may be deleted. `branch -D` on anything else
 *  destroys work this app never wrote. */
const OURS = /^nexotao\//;

/* ── running commands ───────────────────────────────────────────────────────── */

/** Never rejects. A command that cannot even start is reported as a failure
 *  with its own error text, because a rollback that throws halfway leaves the
 *  user worse off than one that keeps going and tells them what it missed. */
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { if (stdout.length < 1_000_000) stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { if (stderr.length < 1_000_000) stderr += c.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(error?.message ?? error) }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

/** Fill in whatever the caller did not inject. Grouped in one place so a test
 *  can override a single dep and inherit real behaviour for the rest. */
function resolveDeps(deps = {}) {
  const home = deps.home ?? os.homedir();
  return {
    exec: deps.exec ?? run,
    home,
    dir: deps.dir ?? (process.env.NEXOTAO_DATA_DIR ? path.resolve(process.env.NEXOTAO_DATA_DIR) : path.join(home, ".nexotao")),
    // TOOLS_DIR is anchored to homedir() rather than the data directory
    // (lib/code-memory.ts:37), so an overridden NEXOTAO_DATA_DIR leaves it
    // behind. It has to be removed on its own.
    toolsDir: deps.toolsDir ?? path.join(home, ".nexotao", "tools"),
    cacheDir: deps.cacheDir ?? path.join(home, ".cache", CACHE_PACKAGE),
    log: deps.log ?? ((line) => process.stdout.write(`${line}\n`)),
    prompt: deps.prompt ?? promptTty,
    // Whether anyone can answer the confirmation. Injected rather than read
    // from `process.stdin` at the point of use so that a test exercising the
    // prompt is not silently rerouted into the unattended branch.
    interactive: deps.interactive ?? Boolean(process.stdin.isTTY),
    port: deps.port ?? (process.env.PORT || "4319"),
    probe: deps.probe ?? probeRunningApp,
    fs: deps.fs ?? fs,
  };
}

/* ── argv ───────────────────────────────────────────────────────────────────── */

export function parseArgs(argv = []) {
  const opts = { force: false, yes: false, dryRun: false, keepPackage: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") opts.force = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--keep-package") opts.keepPackage = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else opts.unknown.push(arg);
  }
  return opts;
}

export const USAGE = `nexotao uninstall — remove Nexotao and everything it created

  --dry-run, -n     show what would be removed, then stop
  --force,   -f     proceed even when a worktree has uncommitted work
  --yes,     -y     skip the typed confirmation
  --keep-package    leave the npm package installed
  --help,    -h     show this message`;

/* ── inventory ──────────────────────────────────────────────────────────────── */

/** Which repository owns this worktree, without consulting the database.
 *
 *  A worktree is self-describing: its `.git` file holds
 *  `gitdir: <owner>/.git/worktrees/<name>`. That matters because
 *  `gitWorkspaces` rows cascade away with their project while the directories
 *  on disk survive — so by the time anyone uninstalls, the database may have
 *  forgotten worktrees that are still registered in the user's repository.
 *  Ask git first (it handles the ordinary case and follows relative paths),
 *  and fall back to reading the pointer ourselves when git refuses because the
 *  owner moved. */
async function resolveOwner(worktree, d) {
  const r = await d.exec("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 15_000 });
  if (r.code === 0 && r.stdout) return r.stdout.trim().replace(/[/\\]\.git[/\\]?$/, "");
  try {
    const pointer = await d.fs.readFile(path.join(worktree, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
    if (!match) return null;
    const gitdir = match[1].trim();
    const owner = gitdir.replace(/[/\\]\.git[/\\]worktrees[/\\][^/\\]+[/\\]?$/, "");
    return owner === gitdir ? null : owner;
  } catch {
    return null;
  }
}

/** Every managed worktree on disk, with what we need to decide its fate.
 *  Walks `<dir>/worktrees/<repoKey>/<name>` — the layout
 *  `GitWorkspaceManager` writes (lib/git-workspace.ts:153). */
export async function scanWorktrees(root, deps = {}) {
  const d = resolveDeps(deps);
  const found = [];
  const repoKeys = await d.fs.readdir(root).catch(() => []);
  for (const repoKey of repoKeys.sort()) {
    const bucket = path.join(root, repoKey);
    if (!(await isDirectory(bucket, d))) continue;
    for (const name of (await d.fs.readdir(bucket).catch(() => [])).sort()) {
      const worktree = path.join(bucket, name);
      if (!(await isDirectory(worktree, d))) continue;
      const owner = await resolveOwner(worktree, d);
      const branch = owner
        ? await d.exec("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 15_000 })
          .then((r) => (r.code === 0 && r.stdout ? r.stdout.trim() : null))
        : null;
      const status = owner
        ? await d.exec("git", ["-C", worktree, "status", "--porcelain"], { timeoutMs: 30_000 })
        : { code: 1, stdout: "", stderr: "" };
      const dirtyLines = status.code === 0 ? status.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
      found.push({
        path: worktree,
        label: `${path.basename(owner ?? repoKey)}/${name}`,
        owner,
        branch,
        dirtyCount: dirtyLines.length,
        dirtySample: dirtyLines.slice(0, 3).map((l) => l.replace(/^\S+\s+/, "")),
      });
    }
  }
  return found;
}

async function isDirectory(target, d) {
  return d.fs.stat(target).then((s) => s.isDirectory()).catch(() => false);
}

/* ── repositories we have written into ──────────────────────────────────────── */

/** Every project folder the app knows about, read straight out of its database.
 *
 *  Snapshot refs are the reason this exists. A worktree announces itself twice —
 *  a directory under `<dir>/worktrees/` and a registration in the repository — so
 *  scanning the disk finds it. A snapshot ref announces itself nowhere: it is a
 *  ref inside the user's repository and nothing under ~/.nexotao names the folder
 *  it is in. Miss that folder and the ref survives the uninstall for good.
 *
 *  `config.json` is not the answer despite holding the active project id — it
 *  stores no paths at all. The `projects` table is where they are, so this opens
 *  the SQLite file read-only and asks. Failure at every step is expected and
 *  silent: `node:sqlite` only exists from Node 22.5 (package.json allows 18.18),
 *  the database may predate the table, and an uninstall must not require either.
 *  What is lost then is ref cleanup in repositories that never hosted a worktree;
 *  everything else proceeds. */
async function projectRepositories(d) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return []; }
  const file = path.join(d.dir, "nexotao.sqlite");
  if (!(await d.fs.stat(file).then(() => true).catch(() => false))) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare("select path from projects").all()
      .map((row) => row?.path)
      .filter((value) => typeof value === "string" && value)
      // Paths are stored as the user typed them, `~` and all (lib/paths.ts).
      .map((value) => (value === "~" || value.startsWith("~/") ? path.join(d.home, value.slice(1)) : value));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed, or never opened */ }
  }
}

/** Refs under `refs/nexotao/` in one repository, with the ref name we would
 *  delete. The whole namespace rather than `refs/nexotao/snapshots/` alone: it is
 *  ours entirely, and a version that wrote a different ref under it should not
 *  outlive the uninstall on a technicality. */
async function refsIn(repo, d) {
  const r = await d.exec("git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/nexotao/"], { timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("refs/nexotao/"));
}

/** Every `refs/nexotao/` ref across every repository we can find, grouped by
 *  repository so the plan can name them. The two sources are unioned because
 *  neither is complete on its own: the worktree scan finds repositories the
 *  database has forgotten, and the database finds repositories that never had a
 *  worktree — which, after this release, is all of them. */
export async function scanSnapshotRefs(owners, deps = {}) {
  const d = resolveDeps(deps);
  const repos = [...new Set([...owners, ...(await projectRepositories(d))].filter(Boolean).map((repo) => path.resolve(repo)))].sort();
  const found = [];
  for (const repo of repos) {
    const refs = await refsIn(repo, d);
    if (refs.length) found.push({ repo, refs });
  }
  return found;
}

/** Hand one repository's refs back. Best-effort per ref: a ref that is already
 *  gone, or a repository that has become unreadable since the scan, must not
 *  stop the others. */
export async function releaseSnapshotRefs(entry, deps = {}) {
  const d = resolveDeps(deps);
  const problems = [];
  let released = 0;
  for (const ref of entry.refs) {
    const r = await d.exec("git", ["-C", entry.repo, "update-ref", "-d", ref], { timeoutMs: 30_000 });
    if (r.code === 0) released += 1;
    else problems.push(`${entry.repo}: could not delete ${ref} (${firstLine(r.stderr || r.stdout) || `git exited ${r.code}`})`);
  }
  return { released, problems };
}

/** Recursive byte total. Best-effort: an unreadable subtree contributes 0
 *  rather than aborting a report whose only job is to inform. */
async function measure(target, d) {
  const entries = await d.fs.readdir(target, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return d.fs.stat(target).then((s) => (s.isFile() ? s.size : 0)).catch(() => 0);
  }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) total += await measure(child, d);
    else if (entry.isFile()) total += await d.fs.stat(child).then((s) => s.size).catch(() => 0);
  }
  return total;
}

/** Our own index files in the shared cache — and only ours.
 *  `~/.cache/codebase-memory-mcp` is shared with indexes the user built by hand
 *  for their own MCP setup; on a real machine every file there can belong to
 *  them. Matching the prefix is what makes this safe. */
async function ourCacheFiles(cacheDir, d) {
  const entries = await d.fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(INDEX_PREFIX)) continue;
    const file = path.join(cacheDir, entry.name);
    files.push({ path: file, bytes: await d.fs.stat(file).then((s) => s.size).catch(() => 0) });
  }
  return files;
}

/** Reads only. Nothing here removes anything. */
export async function planUninstall(deps = {}) {
  const d = resolveDeps(deps);
  const worktrees = await scanWorktrees(path.join(d.dir, "worktrees"), deps);
  const byRepo = new Map();
  for (const wt of worktrees) {
    const key = wt.owner ?? "(unknown repository)";
    byRepo.set(key, (byRepo.get(key) ?? 0) + 1);
  }
  const snapshotRefs = await scanSnapshotRefs(worktrees.map((wt) => wt.owner).filter(Boolean), deps);
  const cacheFiles = await ourCacheFiles(d.cacheDir, d);
  const dirExists = await d.fs.stat(d.dir).then(() => true).catch(() => false);
  const toolsSeparate = path.resolve(d.toolsDir) !== path.resolve(path.join(d.dir, "tools"));
  return {
    snapshotRefs,
    snapshotRefCount: snapshotRefs.reduce((sum, entry) => sum + entry.refs.length, 0),
    dir: d.dir,
    dirBytes: dirExists ? await measure(d.dir, d) : 0,
    dirExists,
    toolsDir: toolsSeparate ? d.toolsDir : null,
    toolsBytes: toolsSeparate ? await measure(d.toolsDir, d) : 0,
    cacheDir: d.cacheDir,
    cacheFiles,
    cacheBytes: cacheFiles.reduce((sum, f) => sum + f.bytes, 0),
    worktrees,
    repos: [...byRepo.entries()].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count),
    dirty: worktrees.filter((w) => w.dirtyCount > 0),
    unresolved: worktrees.filter((w) => !w.owner),
  };
}

/* ── rendering ──────────────────────────────────────────────────────────────── */

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The confirmation screen. States what survives as prominently as what goes:
 *  the two things a user is most afraid of losing here are their own commits
 *  and the code indexes they built themselves, and neither is touched. */
export function renderPlan(plan, opts = {}) {
  // Two columns, laid out once. A user scanning this is comparing sizes; a
  // ragged right edge makes them read every line to do it.
  const rows = [];
  if (plan.dirExists) rows.push([plan.dir, formatBytes(plan.dirBytes)]);
  if (plan.toolsDir && plan.toolsBytes) rows.push([plan.toolsDir, formatBytes(plan.toolsBytes)]);
  if (plan.cacheFiles.length) {
    rows.push([`${plan.cacheFiles.length} code index file${plan.cacheFiles.length === 1 ? "" : "s"} in ${plan.cacheDir}`, formatBytes(plan.cacheBytes)]);
  }
  const width = Math.max(0, ...rows.map(([label]) => label.length));

  const lines = ["", "  This will permanently remove:", ""];
  for (const [label, size] of rows) {
    lines.push(`    ${label.padEnd(width)}   ${size.padStart(8)}`);
    if (label === plan.dir) lines.push("      • database, settings and API key, work graphs, backups");
  }
  if (!opts.keepPackage) lines.push(`    the ${PACKAGE_NAME} npm package`);

  if (plan.worktrees.length) {
    lines.push("", `  ${plan.worktrees.length} worktree${plan.worktrees.length === 1 ? "" : "s"} released back to ${plan.repos.length} repositor${plan.repos.length === 1 ? "y" : "ies"}:`, "");
    const repoWidth = Math.max(...plan.repos.map(({ repo }) => repo.length));
    for (const { repo, count } of plan.repos) lines.push(`    ${repo.padEnd(repoWidth)}   ${String(count).padStart(3)}`);
  }

  // Its own section, because it is the one thing here a user cannot see for
  // themselves: these refs are inside repositories they own and `git branch`
  // never shows them.
  if (plan.snapshotRefCount) {
    lines.push("", `  ${plan.snapshotRefCount} undo point${plan.snapshotRefCount === 1 ? "" : "s"} (refs/nexotao/) removed from ${plan.snapshotRefs.length} repositor${plan.snapshotRefs.length === 1 ? "y" : "ies"}:`, "");
    const refWidth = Math.max(...plan.snapshotRefs.map(({ repo }) => repo.length));
    for (const { repo, refs } of plan.snapshotRefs) lines.push(`    ${repo.padEnd(refWidth)}   ${String(refs.length).padStart(3)}`);
  }

  lines.push("", "  NOT touched:", "", "    your code, commits and branches", `    other indexes in ${plan.cacheDir}`);
  if (plan.dirty.length) lines.push("", `  ⚠  ${plan.dirty.length} worktree${plan.dirty.length === 1 ? " has" : "s have"} uncommitted work`);
  if (plan.unresolved.length) lines.push("", `  ⚠  ${plan.unresolved.length} worktree${plan.unresolved.length === 1 ? "" : "s"} could not be traced to a repository`);
  lines.push("");
  return lines.join("\n");
}

export function renderDirty(plan, opts = {}) {
  const lines = ["", `⚠  ${plan.dirty.length} worktree${plan.dirty.length === 1 ? " contains" : "s contain"} uncommitted work:`, ""];
  const width = Math.max(...plan.dirty.map((w) => w.label.length));
  for (const wt of plan.dirty) {
    const files = `${wt.dirtyCount} file${wt.dirtyCount === 1 ? "" : "s"}`;
    const sample = wt.dirtySample.length ? `  (${wt.dirtySample.join(", ")}${wt.dirtyCount > wt.dirtySample.length ? ", …" : ""})` : "";
    lines.push(`   ${wt.label.padEnd(width)}  ${files.padEnd(9)}${sample}`);
  }
  lines.push("", "Copy anything you need, then re-run with --force.");
  if (!opts.listOnly) lines.push("Cancelled — nothing was deleted.");
  lines.push("");
  return lines.join("\n");
}

/* ── the destructive half ───────────────────────────────────────────────────── */

/** Hand one worktree back to the repository that owns it.
 *
 *  Each step is independent and best-effort, mirroring `discardWorkspace`
 *  (lib/git-workspace.ts): `worktree remove` legitimately fails when the
 *  registration is already gone, and letting that abort the sequence would skip
 *  the branch deletion — which is the step that actually matters, because the
 *  branch is what the user is left staring at. */
export async function releaseWorktree(wt, deps = {}) {
  const d = resolveDeps(deps);
  const problems = [];
  if (wt.owner) {
    await d.exec("git", ["-C", wt.owner, "worktree", "remove", "--force", wt.path], { timeoutMs: 60_000 });
    await d.exec("git", ["-C", wt.owner, "worktree", "prune"], { timeoutMs: 60_000 });
  }
  // A directory left by a partial checkout is not a worktree git will remove,
  // but it still occupies the path and still counts as our litter.
  const removed = await d.fs.rm(wt.path, { recursive: true, force: true }).then(() => true, (e) => e);
  if (removed !== true) problems.push(`${wt.label}: ${removed?.message ?? removed}`);

  if (wt.owner && wt.branch && OURS.test(wt.branch)) {
    const r = await d.exec("git", ["-C", wt.owner, "branch", "-D", wt.branch], { timeoutMs: 30_000 });
    // A branch that is already gone is a success, not a problem worth naming.
    if (r.code !== 0 && !/not found/i.test(`${r.stderr}${r.stdout}`)) {
      problems.push(`${wt.label}: could not delete ${wt.branch} (${firstLine(r.stderr || r.stdout)})`);
    }
  }
  if (!wt.owner) problems.push(`${wt.label}: could not find its repository; run \`git worktree prune\` there`);
  return { ok: problems.length === 0, problems };
}

function firstLine(text) {
  return String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
}

/** Is a Nexotao server already answering on the local port? Deleting the
 *  database out from under a live process is how a half-written SQLite file
 *  happens, so this refuses rather than racing. A stranger on the port is not
 *  our business — only our own health signature counts. */
function probeRunningApp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1_000 }, (res) => {
      let body = "";
      res.on("data", (c) => { if (body.length < 4096) body += c.toString("utf8"); });
      res.on("end", () => {
        // 401 counts: the auth gate answering at all means our server is up.
        try { resolve(res.statusCode === 401 || JSON.parse(body)?.ok === true); }
        catch { resolve(res.statusCode === 401); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

/** Ctrl-D at the prompt has to resolve to *something*, so `close` resolves too.
 *  It must not overwrite a real answer: `rl.close()` emits `close` synchronously
 *  from inside the question callback, so resolving there directly would hand
 *  back `null` and tell a user who typed the word correctly that they had
 *  cancelled. Record the answer first; let `close` speak only for the case
 *  where there is none. */
export function promptTty(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer = null;
    rl.on("close", () => resolve(answer));
    rl.question(question, (value) => { answer = value; rl.close(); });
  });
}

/**
 * Exit codes: 0 clean · 1 finished with problems · 2 stopped before touching
 * anything (dirty worktrees, declined confirmation, a running server).
 */
export async function runUninstall(opts = {}, deps = {}) {
  const d = resolveDeps(deps);
  const report = { released: 0, repos: [], refsReleased: 0, problems: [], freedBytes: 0, packageRemoved: false, cancelled: null };

  if (opts.help) { d.log(USAGE); return { exitCode: 0, report }; }
  if (opts.unknown?.length) {
    d.log(`Unknown option: ${opts.unknown[0]}\n\n${USAGE}`);
    return { exitCode: 2, report: { ...report, cancelled: "unknown-option" } };
  }

  if (!opts.dryRun && (await d.probe(d.port))) {
    d.log("\nNexotao is running. Stop it (Ctrl-C in its terminal) and try again.\n");
    return { exitCode: 2, report: { ...report, cancelled: "running" } };
  }

  const plan = await planUninstall(deps);

  // Nothing at all to do reads as success, not as a failure to find anything.
  if (!plan.dirExists && !plan.worktrees.length && !plan.snapshotRefCount && !plan.cacheFiles.length && opts.keepPackage) {
    d.log("\nNothing to remove — no Nexotao data found.\n");
    return { exitCode: 0, report };
  }

  // A dry run is read-only, so it answers the question it was asked — the full
  // plan — rather than stopping at the dirty gate. Stopping there would hide
  // the very inventory the flag exists to show.
  if (opts.dryRun) {
    d.log(renderPlan(plan, opts));
    if (plan.dirty.length) d.log(renderDirty(plan, { listOnly: true }));
    d.log("Dry run — nothing was deleted.\n");
    return { exitCode: 0, report: { ...report, cancelled: "dry-run" } };
  }

  if (plan.dirty.length && !opts.force) {
    d.log(renderDirty(plan));
    return { exitCode: 2, report: { ...report, cancelled: "dirty" } };
  }

  d.log(renderPlan(plan, opts));

  if (!opts.yes) {
    // Without a terminal there is nobody to type the word, and assuming consent
    // for something irreversible is exactly the wrong default.
    if (!d.interactive) {
      d.log(`Refusing to run unattended. Re-run with --yes if you are sure.\n`);
      return { exitCode: 2, report: { ...report, cancelled: "no-tty" } };
    }
    const answer = await d.prompt(`  Type ${CONFIRMATION} to continue: `);
    if (String(answer ?? "").trim() !== CONFIRMATION) {
      d.log("\nCancelled — nothing was deleted.\n");
      return { exitCode: 2, report: { ...report, cancelled: "declined" } };
    }
  }

  // Release before deleting. Reversing these two is the bug this command
  // exists to prevent: `rm -rf` first strands the registry in every repository.
  for (const wt of plan.worktrees) {
    const result = await releaseWorktree(wt, deps);
    if (result.ok) report.released += 1;
    report.problems.push(...result.problems);
  }
  report.repos = plan.repos;

  // After the worktrees, and before the data directory goes: once ~/.nexotao is
  // deleted the database that named these repositories is gone, and a ref left
  // in one of them has nothing left pointing at it.
  for (const entry of plan.snapshotRefs) {
    const result = await releaseSnapshotRefs(entry, deps);
    report.refsReleased += result.released;
    report.problems.push(...result.problems);
  }

  const removeDir = async (target, bytes) => {
    const outcome = await d.fs.rm(target, { recursive: true, force: true }).then(() => true, (e) => e);
    if (outcome === true) report.freedBytes += bytes;
    else report.problems.push(`${target}: ${outcome?.message ?? outcome}`);
  };
  await removeDir(plan.dir, plan.dirBytes);
  if (plan.toolsDir) await removeDir(plan.toolsDir, plan.toolsBytes);

  // Prefix-scoped, file by file. Never the directory, never an unprefixed
  // file: the cost of deleting an index the user built by hand is far higher
  // than the disk we would reclaim.
  for (const file of plan.cacheFiles) {
    const outcome = await d.fs.rm(file.path, { force: true }).then(() => true, (e) => e);
    if (outcome === true) report.freedBytes += file.bytes;
    else report.problems.push(`${file.path}: ${outcome?.message ?? outcome}`);
  }

  // Last, because it removes the code that is running. On POSIX this script is
  // already resident in memory, so deleting it mid-run is safe.
  if (!opts.keepPackage) {
    const r = await d.exec("npm", ["uninstall", "-g", PACKAGE_NAME], { timeoutMs: 10 * 60_000 });
    if (r.code === 0) report.packageRemoved = true;
    else {
      // A global prefix is often root-owned. We print the escalated command
      // rather than running it: a destructive command should never silently
      // acquire privileges it was not given.
      report.problems.push(`could not remove the ${PACKAGE_NAME} package (${firstLine(r.stderr || r.stdout) || `npm exited ${r.code}`})\n  finish with:  sudo npm uninstall -g ${PACKAGE_NAME}`);
    }
  }

  d.log(renderReport(report));
  return { exitCode: report.problems.length ? 1 : 0, report };
}

export function renderReport(report) {
  const lines = [""];
  if (report.released) {
    lines.push(`  Released ${report.released} worktree${report.released === 1 ? "" : "s"}:`, "");
    const width = Math.max(...report.repos.map(({ repo }) => repo.length));
    for (const { repo, count } of report.repos) lines.push(`    ${repo.padEnd(width)}   ${String(count).padStart(3)}`);
    lines.push("");
  }
  if (report.refsReleased) {
    lines.push(`  Removed ${report.refsReleased} undo point${report.refsReleased === 1 ? "" : "s"} from refs/nexotao/.`);
  }
  lines.push(`  Freed ${formatBytes(report.freedBytes)}.`);
  if (report.packageRemoved) lines.push(`  Removed the ${PACKAGE_NAME} package.`);
  if (report.problems.length) {
    lines.push("", "  Could not finish everything:", "");
    for (const problem of report.problems) lines.push(`    ${problem}`);
    lines.push("");
  } else {
    lines.push("", "  Nexotao is gone. Thanks for trying it.", "");
  }
  return lines.join("\n");
}
