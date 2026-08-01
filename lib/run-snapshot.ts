/* The safety net for a run that edits the user's project folder directly.
 *
 * The agent works in the folder the user has open — the same one their editor,
 * their terminal and their `npm test` are pointed at. That is the whole point:
 * a run that writes somewhere else is a run whose work the user cannot see,
 * build, or test. What it costs is the ability to undo, and this module buys
 * that back.
 *
 * Before each write-capable run we record the folder exactly as it stands —
 * committed, staged, modified, and untracked alike — as a dangling commit under
 * `refs/nexotao/snapshots/<runId>`. It is built with plumbing (`add -A` against
 * a throwaway index, `write-tree`, `commit-tree`, `update-ref`) so that nothing
 * the user can see moves: not the working tree, not their index, not HEAD, and
 * not any branch. `git status`, `git branch` and `git log` are all unchanged by
 * it. Afterwards the same plumbing diffs the snapshot against the folder as it
 * now is, and restores from it on request.
 *
 * This replaces the per-run `git worktree`. That design isolated runs from a
 * folder they were never going to share — one project has one agent, and one
 * agent has at most one live run — while making the run's own work unbuildable,
 * because `git worktree add` checks out tracked files only and leaves
 * `node_modules`, `.env` and every other ignored path behind. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DIR } from "./config";

export type GitIdentity = { name: string; email: string };

/** Why a run has no safety net. Each is surfaced to the user verbatim rather
 *  than collapsed into "unavailable", because the answer to "so what do I do?"
 *  is different for each: `not_a_repo` is a folder we could not initialise,
 *  `no_git` needs Git installed, `capture_failed` is worth retrying. */
export type SnapshotUnavailable = "not_a_repo" | "no_git" | "capture_failed";

export type Snapshot =
  | { available: true; commit: string; head: string | null }
  | { available: false; reason: SnapshotUnavailable; detail: string };

export type ChangeStatus = "A" | "M" | "D" | "R";
export type ChangedFile = { path: string; oldPath?: string; status: ChangeStatus };

/** Commits made *inside* the run window — by the agent, or by the user working
 *  alongside it. Reverting restores file contents and deliberately leaves these
 *  in place; see `restore`. */
export type OutgoingCommits = { count: number; from: string; to: string };

function within(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Lead with the line that says *why* the command failed. Git narrates progress
 *  on stderr before the `fatal:` line that actually explains the failure, so
 *  using stderr verbatim buries the cause behind noise — and any caller that
 *  truncates to one line (the inbox does) shows only the narration. Diagnostic
 *  lines are kept after the cause so nothing is lost. */
export function failureMessage(stderr: string, stdout: string, fallback: string) {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return fallback;
  const causeIndex = lines.findIndex((line) => /^(?:fatal|error):/i.test(line));
  if (causeIndex === -1) return lines.join("\n");
  return [lines[causeIndex], ...lines.slice(0, causeIndex), ...lines.slice(causeIndex + 1)].join("\n");
}

function command(
  commandName: string, args: string[], cwd: string,
  options: { timeoutMs?: number; env?: Record<string, string>; raw?: boolean } = {},
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
    });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (target === "stdout" && stdout.length < 2_000_000) stdout += value.slice(0, 2_000_000 - stdout.length);
      if (target === "stderr" && stderr.length < 2_000_000) stderr += value.slice(0, 2_000_000 - stderr.length);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      // Trimming is right for the plumbing this module mostly runs — a SHA, a
      // ref name, a count — and wrong for exactly one caller. `cat-file blob`
      // returns a *file*, and eating its trailing newline makes every text file
      // in the world look modified on its last line.
      if (code === 0) resolve({ stdout: options.raw ? stdout : stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(failureMessage(stderr, stdout, `${commandName} exited with ${code}`)));
    });
  });
}

/** Windows refuses a path over 260 characters unless `core.longpaths` is on.
 *  Passed per invocation rather than written into the user's config, because it
 *  is ours to need and not theirs to keep; the key is inert off Windows, so the
 *  platform check is only to keep the command line honest about what it is
 *  for. */
const GIT_PLATFORM_ARGS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

export async function git(cwd: string, ...args: string[]) {
  return command("git", [...GIT_PLATFORM_ARGS, ...args], cwd);
}

/** Run a plumbing command against a scratch index instead of the user's.
 *
 *  This is the single most important detail in the module. `git add -A` and
 *  `git checkout <tree> -- .` both write `.git/index` by default, so running
 *  either one against the real index would silently discard whatever the user
 *  had staged — work they did by hand, that we never touched, gone without a
 *  message. Pointing GIT_INDEX_FILE at a throwaway makes both operations
 *  invisible to `git status` and `git diff --cached`. */
async function withScratchIndex<T>(runId: string, body: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const scratch = path.join(DIR, "tmp", `index-${runId.replace(/[^a-zA-Z0-9._-]/g, "")}-${process.pid}`);
  await fs.mkdir(path.dirname(scratch), { recursive: true, mode: 0o700 });
  try {
    return await body({ GIT_INDEX_FILE: scratch });
  } finally {
    // A leftover scratch index is inert — nothing reads it but us, and the next
    // call writes its own. Failing the run over one would be absurd.
    await fs.rm(scratch, { force: true }).catch(() => undefined);
  }
}

/** Who a run's commits are authored as when the machine has nobody configured.
 *
 *  Git for Windows does not set `user.name` / `user.email` at install time, and
 *  a user who opens a project they already have — cloned, copied, or committed
 *  to from another machine — never passes through `git init`. So the common
 *  Windows case is a repository with real history and no identity anywhere. */
export const FALLBACK_IDENTITY: GitIdentity = { name: "Nexotao Agent", email: "agent@nexotao.local" };

/** The identity a snapshot commit is made under.
 *
 *  Falls back rather than throwing. `git config --get` exits 1 and prints
 *  *nothing* when a key is simply absent, so throwing here surfaced as
 *  `git exited with 1` — no path, no key, no mention of identity. A user who
 *  has an identity still gets theirs. */
async function repositoryIdentity(repositoryPath: string): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    git(repositoryPath, "config", "--get", "user.name").catch(() => ({ stdout: "" })),
    git(repositoryPath, "config", "--get", "user.email").catch(() => ({ stdout: "" })),
  ]);
  // Both or neither: a repo with a name and no email would otherwise commit as
  // "Their Name <agent@nexotao.local>", an identity belonging to no one.
  if (!name.stdout || !email.stdout) return FALLBACK_IDENTITY;
  return { name: name.stdout, email: email.stdout };
}

/** `-c` overrides that make a commit-creating command author as `identity`,
 *  passed per invocation rather than written into the user's config. */
function identityArgs(identity: GitIdentity) {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

export async function isRepository(root: string) {
  return git(root, "rev-parse", "--git-dir").then(() => true).catch(() => false);
}

/** Make a plain folder snapshottable by initialising a repository in it.
 *
 *  The reason changed with the design and is worth stating plainly: this used to
 *  exist because `git worktree add` cannot run without a repository, so a
 *  non-repo folder could not run at all. Runs work fine in a plain folder now.
 *  What a repository buys today is Revert — without one there is nowhere to
 *  record what the folder looked like, and a run that goes wrong is permanent.
 *
 *  A folder that is already inside a repository is left alone. */
async function ensureRepository(root: string) {
  if (await isRepository(root)) return;
  await git(root, "init");
  await ensureIdentity(root);
  const hasHead = await git(root, "rev-parse", "--verify", "HEAD").then(() => true).catch(() => false);
  if (hasHead) return;
  const identity = await repositoryIdentity(root);
  // Capture any pre-existing files into the base commit so the folder's starting
  // state is recoverable too, not just what the first run changes.
  await git(root, "add", "-A").catch(() => undefined);
  const staged = (await git(root, "diff", "--cached", "--name-only")).stdout;
  const commitArgs = staged ? ["commit", "-m", "chore: initialize workspace"] : ["commit", "--allow-empty", "-m", "chore: initialize workspace"];
  await git(root, ...identityArgs(identity), ...commitArgs);
}

/** Ensure a repo has an author identity so commits succeed. Only fills in a
 *  default when neither local nor global config provides one. */
async function ensureIdentity(root: string) {
  const name = await git(root, "config", "user.name").then((r) => r.stdout).catch(() => "");
  const email = await git(root, "config", "user.email").then((r) => r.stdout).catch(() => "");
  if (!name) await git(root, "config", "user.name", FALLBACK_IDENTITY.name);
  if (!email) await git(root, "config", "user.email", FALLBACK_IDENTITY.email);
}

export function snapshotRef(runId: string) {
  return `refs/nexotao/snapshots/${runId}`;
}

/** Hash the folder as it stands into a commit nothing points at but us.
 *
 *  Never throws into the run. Git missing, a 40 GB untracked build directory
 *  timing out, an index locked by a rebase the user left half-finished — all of
 *  it comes back as `{ available: false }` and the run proceeds without a net.
 *  The old worktree provisioning had the opposite contract, and rightly so: a
 *  failure there meant there was nowhere to execute. A failure here means only
 *  that Revert will not be on offer, which is worth saying out loud and not
 *  worth abandoning the user's request over.
 *
 *  Note `add -A` honours `.gitignore`, so ignored paths are neither recorded nor
 *  restorable. That is the right trade — nobody wants `node_modules` in a
 *  snapshot tree — but it is a real limit and the UI states it. */
export async function capture(root: string, runId: string): Promise<Snapshot> {
  try {
    await ensureRepository(root);
  } catch (error) {
    const detail = (error as Error).message;
    // Tell "git is not installed" apart from "this folder resists a repository",
    // because only one of them is something the user can act on quickly.
    const reason: SnapshotUnavailable = /ENOENT|not found/i.test(detail) ? "no_git" : "not_a_repo";
    return { available: false, reason, detail };
  }

  try {
    const head = await git(root, "rev-parse", "--verify", "HEAD").then((r) => r.stdout).catch(() => null);
    const identity = await repositoryIdentity(root);
    const commit = await withScratchIndex(runId, async (env) => {
      await command("git", [...GIT_PLATFORM_ARGS, "add", "-A", "--"], root, { env });
      const tree = (await command("git", [...GIT_PLATFORM_ARGS, "write-tree"], root, { env })).stdout;
      // No `-p` at all when the repository has no commits yet. `commit-tree -p
      // HEAD` fails outright there, and a parentless root commit is exactly the
      // right thing to record: the folder before us, with nothing behind it.
      const parent = head ? ["-p", head] : [];
      const args = [...identityArgs(identity), "commit-tree", tree, ...parent, "-m", `nexotao snapshot ${runId}`];
      return (await command("git", [...GIT_PLATFORM_ARGS, ...args], root, { env })).stdout;
    });
    await git(root, "update-ref", snapshotRef(runId), commit);
    return { available: true, commit, head };
  } catch (error) {
    return { available: false, reason: "capture_failed", detail: (error as Error).message };
  }
}

/** The folder as it stands right now, as a tree object, without disturbing
 *  anything. The other half of every comparison in this module. */
async function currentTree(root: string, runId: string) {
  return withScratchIndex(runId, async (env) => {
    await command("git", [...GIT_PLATFORM_ARGS, "add", "-A", "--"], root, { env });
    return (await command("git", [...GIT_PLATFORM_ARGS, "write-tree"], root, { env })).stdout;
  });
}

/** Parse `diff-tree -z --name-status`, whose NUL stream puts a rename's two
 *  paths in the two fields *after* the status rather than beside it. */
function parseNameStatus(raw: string): ChangedFile[] {
  const fields = raw.split("\0").filter((field) => field.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    // `C` (copy) is only emitted with `--find-copies`, which we do not pass —
    // but it shares the three-field shape with `R`, so it is handled here
    // rather than left to desynchronise the whole stream if it ever appears.
    const code = fields[i]![0];
    if (!code) break;
    if (code === "R" || code === "C") {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      if (newPath) files.push({ path: newPath, oldPath, status: "R" });
      i += 3;
    } else {
      const file = fields[i + 1];
      if (file) files.push({ path: file, status: code === "A" || code === "D" ? code : "M" });
      i += 2;
    }
  }
  return files;
}

/** What changed between the snapshot and the folder as it is now.
 *
 *  Both sides are trees built from `add -A`, which is what makes this correct.
 *  `git diff <snapshot>` against a working tree reports *tracked* paths only —
 *  so every file the agent newly created, which is the single most common thing
 *  a run does, would be invisible. Comparing two trees makes creations,
 *  deletions and renames all fall out the same way. */
export async function changedSince(root: string, snapshotCommit: string, runId: string): Promise<ChangedFile[]> {
  const tree = await currentTree(root, runId);
  const raw = await git(root, "diff-tree", "-r", "-z", "-M", "--name-status", snapshotCommit, tree);
  return parseNameStatus(raw.stdout);
}

/** Commits added since the snapshot was taken — the agent's, now that it is
 *  allowed to commit, and any the user made alongside it. */
export async function commitsSince(root: string, head: string | null): Promise<OutgoingCommits | null> {
  if (!head) return null;
  const current = await git(root, "rev-parse", "--verify", "HEAD").then((r) => r.stdout).catch(() => null);
  if (!current || current === head) return null;
  const count = await git(root, "rev-list", "--count", `${head}..HEAD`).then((r) => Number(r.stdout)).catch(() => 0);
  return count > 0 ? { count, from: head, to: current } : null;
}

/** Read one path out of the snapshot. Absent (a file the run created) reads as
 *  empty, which is what the diff viewer wants for an addition anyway. */
export async function fileAtSnapshot(root: string, snapshotCommit: string, file: string): Promise<string | null> {
  // `raw`: the other side of the diff is read straight off disk, so trimming
  // this one would report a last-line change on every file that ends in a
  // newline — which is nearly all of them.
  return command("git", [...GIT_PLATFORM_ARGS, "cat-file", "blob", `${snapshotCommit}:${file}`], root, { raw: true })
    .then((r) => r.stdout).catch(() => null);
}

export type RestoreResult = { restored: string[]; removed: string[]; commits: OutgoingCommits | null };

/** Put the folder back the way the snapshot found it.
 *
 *  Contents only. HEAD does not move, the user's index is untouched, and any
 *  commits made during the run stay in history — including the agent's, now
 *  that it may commit. That is deliberate rather than an omission: rewriting a
 *  range we did not necessarily author alone is not something to do on a button
 *  press, so the caller reports `commits` and hands the user the `git reset`
 *  command to run themselves if they want it.
 *
 *  Files the run created are deleted, since `checkout` has nothing to restore
 *  them to. Each deletion is bounded by `within` — a crafted path in the diff
 *  should not be able to reach outside the project. */
export async function restore(root: string, snapshotCommit: string, runId: string, head: string | null): Promise<RestoreResult> {
  const changes = await changedSince(root, snapshotCommit, runId);
  const commits = await commitsSince(root, head);

  // Restores every modification and deletion in one pass. The scratch index is
  // what keeps this from clobbering whatever the user has staged.
  await withScratchIndex(runId, async (env) => {
    await command("git", [...GIT_PLATFORM_ARGS, "checkout", snapshotCommit, "--", "."], root, { env });
  });

  const removed: string[] = [];
  // A rename shows as its new path plus an `oldPath` the checkout above has
  // already put back, so the new one is a creation as far as cleanup goes.
  for (const change of changes.filter((c) => c.status === "A" || (c.status === "R" && c.oldPath))) {
    const target = path.resolve(root, change.path);
    if (!within(root, target)) continue;
    await fs.rm(target, { force: true }).catch(() => undefined);
    removed.push(change.path);
  }

  const restored = changes.filter((c) => c.status !== "A").map((c) => c.oldPath ?? c.path);
  return { restored, removed, commits };
}

export async function dropSnapshot(root: string, runId: string) {
  await git(root, "update-ref", "-d", snapshotRef(runId)).catch(() => undefined);
}

export async function listSnapshots(root: string): Promise<Array<{ runId: string; commit: string }>> {
  const raw = await git(root, "for-each-ref", "--format=%(refname)%09%(objectname)", "refs/nexotao/snapshots/").catch(() => null);
  if (!raw) return [];
  return raw.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [refname, commit] = line.split("\t");
    return { runId: (refname ?? "").replace("refs/nexotao/snapshots/", ""), commit: commit ?? "" };
  }).filter((entry) => entry.runId && entry.commit);
}

/** Snapshot refs accumulate one per run and nothing collects them on its own,
 *  so this is a real leak if it never runs.
 *
 *  `keep` is the set of runs whose snapshot is still someone's only way back —
 *  in practice the ones whose task is sitting in review, waiting for the user to
 *  look. Everything else is collected once it is older than `maxAgeMs`. The
 *  caller decides what to keep rather than this module guessing, because "is
 *  anyone still going to want to undo this?" is a question about task status,
 *  which lives in the database and not in Git. */
export async function sweepSnapshots(root: string, keep: Set<string>, maxAgeMs = 14 * 24 * 60 * 60 * 1_000) {
  const now = Date.now();
  const dropped: string[] = [];
  for (const { runId, commit } of await listSnapshots(root)) {
    if (keep.has(runId)) continue;
    const committed = await git(root, "show", "-s", "--format=%ct", commit).then((r) => Number(r.stdout) * 1_000).catch(() => 0);
    // An unreadable date means the object is already gone or corrupt; dropping
    // the ref is the right response to that too.
    if (committed && now - committed < maxAgeMs) continue;
    await dropSnapshot(root, runId);
    dropped.push(runId);
  }
  return dropped;
}
