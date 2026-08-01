import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// Plain ESM, shipped under bin/ because lib/ is not published.
import {
  parseArgs, releaseWorktree, runUninstall, scanWorktrees,
  formatBytes, CONFIRMATION, INDEX_PREFIX,
} from "../bin/uninstall.mjs";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();

/** A data directory laid out exactly the way GitWorkspaceManager writes one:
 *  `<dir>/worktrees/<repoKey>/<name>`, plus the files a real install leaves. */
async function fixture(worktreeCount = 2) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "nexotao-uninstall-"));
  const dir = path.join(sandbox, "data");
  const repo = path.join(sandbox, "my-app");
  const cacheDir = path.join(sandbox, "cache");
  await mkdir(repo, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.test");
  await writeFile(path.join(repo, "shared.txt"), "base\n");
  await git(repo, "add", "shared.txt");
  await git(repo, "commit", "-m", "chore: init");

  const bucket = path.join(dir, "worktrees", "abc123def4567890");
  await mkdir(bucket, { recursive: true });
  const worktrees: string[] = [];
  for (let i = 1; i <= worktreeCount; i += 1) {
    const wt = path.join(bucket, `nx-${i}-run${i}`);
    await git(repo, "worktree", "add", "-b", `nexotao/nx-${i}/run${i}`, wt, "HEAD");
    worktrees.push(wt);
  }
  await writeFile(path.join(dir, "config.json"), "{}");
  await writeFile(path.join(dir, "nexotao.sqlite"), "x".repeat(2048));

  return {
    sandbox, dir, repo, cacheDir, worktrees,
    deps: { dir, cacheDir, home: sandbox, toolsDir: path.join(dir, "tools"), probe: async () => false, log: () => {} },
    cleanup: () => rm(sandbox, { recursive: true, force: true }),
  };
}

const gone = async (target: string) => !(await stat(target).then(() => true, () => false));

/* ── the whole reason this command exists ────────────────────────────────────
 * Nexotao registers worktrees inside the *user's own* repositories. `rm -rf`
 * on the data directory pulls those directories out from under git and leaves
 * every affected repo with a stranded registry and dangling `nexotao/*`
 * branches — damage to something we do not own, from an uninstall that looked
 * like it worked. Release has to happen first, and the ordering is the one
 * property no amount of correct release logic can substitute for. */

test("worktrees are released before the data directory is deleted", async () => {
  const f = await fixture(2);
  try {
    const order: string[] = [];
    const recordingFs = new Proxy(fs, {
      get: (target, prop) => (prop === "rm"
        ? (p: string, o: any) => { order.push(`rm:${p}`); return (target as any).rm(p, o); }
        : (target as any)[prop]),
    });
    const exec = async (file: string, args: string[], opts: any) => {
      if (args.includes("worktree") && args.includes("remove")) order.push("release");
      if (file === "npm") return { code: 0, stdout: "removed", stderr: "" };
      return execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
        (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
        (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
      );
    };

    const { exitCode } = await runUninstall({ yes: true }, { ...f.deps, exec, fs: recordingFs });
    assert.equal(exitCode, 0);

    const lastRelease = order.lastIndexOf("release");
    const dirRemoval = order.findIndex((step) => step === `rm:${f.dir}`);
    assert.ok(lastRelease >= 0, "worktrees must actually be released");
    assert.ok(dirRemoval > lastRelease, "the data directory must not be deleted until every worktree is released");

    // The repository is left as the user would want to find it.
    assert.equal(await git(f.repo, "worktree", "list").then((o) => o.split("\n").length), 1);
    assert.equal(await git(f.repo, "branch", "--list", "nexotao/*"), "");
    assert.match(await git(f.repo, "status", "-sb"), /^## main/);
    assert.ok(await gone(f.dir));
  } finally { await f.cleanup(); }
});

/* ── the database has already forgotten ──────────────────────────────────────
 * `gitWorkspaces` rows cascade away with their project while the directories
 * survive on disk, and by the time anyone uninstalls, the owning repo may also
 * have moved. A worktree is self-describing — its `.git` file names its owner —
 * so ownership is recoverable without consulting anything we deleted. */

test("a worktree git no longer recognises is traced through its own .git pointer", async () => {
  const f = await fixture(1);
  try {
    const owner = f.repo;
    // git rev-parse fails; only the pointer file can answer.
    const exec = async (file: string, args: string[]) => {
      if (args.includes("rev-parse")) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      if (args.includes("status")) return { code: 128, stdout: "", stderr: "fatal" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const found = await scanWorktrees(path.join(f.dir, "worktrees"), { ...f.deps, exec });
    assert.equal(found.length, 1);
    assert.equal(found[0].owner, owner, "the .git pointer must resolve the owning repository");
  } finally { await f.cleanup(); }
});

/* ── `branch -D` on something we did not create ──────────────────────────────
 * Deleting a branch is not recoverable from the reflog by anyone who does not
 * know to look. A worktree checked out on `main` — a state a user can reach by
 * hand inside a managed directory — must be released without its branch being
 * touched. */

test("only branches this app created are deleted", async () => {
  const f = await fixture(1);
  try {
    const wt = f.worktrees[0];
    await git(wt, "checkout", "-b", "my-own-work");
    const deletions: string[] = [];
    const exec = async (file: string, args: string[], opts: any) => {
      if (args.includes("branch") && args.includes("-D")) deletions.push(args[args.length - 1]);
      return execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
        (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
        (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
      );
    };
    const [scanned] = await scanWorktrees(path.join(f.dir, "worktrees"), { ...f.deps, exec });
    assert.equal(scanned.branch, "my-own-work");
    const result = await releaseWorktree(scanned, { ...f.deps, exec });
    assert.equal(result.ok, true);
    assert.deepEqual(deletions, [], "a branch we did not create must survive");
    assert.match(await git(f.repo, "branch", "--list", "my-own-work"), /my-own-work/);
    assert.ok(await gone(wt), "the worktree directory is still released");
  } finally { await f.cleanup(); }
});

/* ── work that only exists in one place ──────────────────────────────────────
 * A worktree's uncommitted files exist nowhere else — not on a branch, not in
 * the reflog. Deleting them because the user typed a confirmation about
 * "uninstalling" is a loss they could not have anticipated, so the default is
 * to stop, name the files, and delete nothing at all. */

test("uncommitted work stops the command before anything is deleted", async () => {
  const f = await fixture(2);
  try {
    await writeFile(path.join(f.worktrees[0], "unsaved.md"), "work in progress\n");
    const destructive: string[] = [];
    const exec = async (file: string, args: string[], opts: any) => {
      if (args.includes("remove") || args.includes("-D") || file === "npm") destructive.push(args.join(" "));
      return execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
        (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
        (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
      );
    };
    let printed = "";
    const deps = { ...f.deps, exec, log: (l: string) => { printed += l; } };

    const stopped = await runUninstall({ yes: true }, deps);
    assert.equal(stopped.exitCode, 2);
    assert.equal(stopped.report.cancelled, "dirty");
    assert.deepEqual(destructive, [], "nothing may be removed when the command stops");
    assert.match(printed, /unsaved\.md/, "the user must be told which files, not just how many");
    assert.match(printed, /--force/);
    assert.ok(!(await gone(f.dir)), "the data directory survives");
    assert.ok(!(await gone(f.worktrees[0])));

    // --force is the escape hatch, and it does proceed.
    const forced = await runUninstall({ yes: true, force: true, keepPackage: true }, deps);
    assert.equal(forced.exitCode, 0);
    assert.equal(forced.report.released, 2);
    assert.ok(await gone(f.dir));
  } finally { await f.cleanup(); }
});

/* ── a cache we share with the user ──────────────────────────────────────────
 * ~/.cache/codebase-memory-mcp holds indexes the user built by hand for their
 * own MCP setup — on a real machine, every file there can be theirs and none
 * ours. Reclaiming a few megabytes is worth far less than deleting one of
 * those, so only our own prefix is ever a candidate, and never the directory
 * itself. */

test("only our own code indexes leave the shared cache", async () => {
  const f = await fixture(0);
  try {
    const put = async (name: string) => {
      const file = path.join(f.cacheDir, name);
      await writeFile(file, "x".repeat(128));
      return file;
    };
    const ours = await put(`${INDEX_PREFIX}p1.db`);
    const oursWal = await put(`${INDEX_PREFIX}p1.db-wal`);
    const theirs = await put("srv-nexotao-apps-agent.db");
    const corrupt = await put("srv-nexotao-apps-agent.db.corrupt");
    await mkdir(path.join(f.cacheDir, "nexotao-refresh"), { recursive: true });
    await writeFile(path.join(f.cacheDir, "nexotao-refresh", "marker"), "x");

    const exec = async (file: string) => ({ code: file === "npm" ? 0 : 1, stdout: "", stderr: "" });
    const { exitCode } = await runUninstall({ yes: true }, { ...f.deps, exec });
    assert.equal(exitCode, 0);

    assert.ok(await gone(ours), "our index is removed");
    assert.ok(await gone(oursWal), "and its sidecar with it");
    for (const keep of [theirs, corrupt]) assert.ok(!(await gone(keep)), `must survive: ${path.basename(keep)}`);
    assert.ok(!(await gone(path.join(f.cacheDir, "nexotao-refresh", "marker"))), "a directory belonging to other tooling is never a candidate");
    assert.ok(!(await gone(f.cacheDir)), "the shared cache directory itself is never removed");
  } finally { await f.cleanup(); }
});

/* ── consent has to be deliberate ────────────────────────────────────────────
 * This is irreversible and it runs in a terminal where `y` is muscle memory.
 * Only the exact word counts, and a pipe with nobody at the keyboard is not
 * consent at all. */

test("the confirmation must be typed exactly, and is never assumed", async () => {
  const f = await fixture(1);
  try {
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    for (const answer of ["y", "yes", "uninstall", "", "  ", null]) {
      const result = await runUninstall({}, { ...f.deps, exec, interactive: true, prompt: async () => answer });
      assert.equal(result.exitCode, 2, `"${answer}" must not proceed`);
      assert.equal(result.report.cancelled, "declined");
      assert.ok(!(await gone(f.dir)), `"${answer}" must delete nothing`);
    }
    // Padding around the right word is a typed confirmation, not a near miss.
    const accepted = await runUninstall({ keepPackage: true }, { ...f.deps, exec, interactive: true, prompt: async () => ` ${CONFIRMATION} ` });
    assert.equal(accepted.exitCode, 0);
    assert.ok(await gone(f.dir));
  } finally { await f.cleanup(); }
});

/* ── the prompt itself, not a stand-in ───────────────────────────────────────
 * Every other test injects `prompt`, so the real readline path was never
 * exercised — and it was wrong: `rl.close()` emits `close` synchronously from
 * inside the question callback, so a promise that resolved there handed back
 * `null` and told a user who had typed the word correctly that they cancelled.
 * A confirmation that cannot be confirmed makes the whole command unusable, and
 * only a test that drives real stdin can see it. */

test("the word typed at the real prompt is the word that is read", async () => {
  const { Readable, Writable } = await import("node:stream");
  const stdin = process.stdin;
  const stdout = process.stdout;
  try {
    for (const [typed, expected] of [[`${CONFIRMATION}\n`, CONFIRMATION], ["yes\n", "yes"], ["", null]] as const) {
      const input = Readable.from([typed]);
      const sink = new Writable({ write: (_c, _e, cb) => cb() });
      Object.defineProperty(process, "stdin", { value: input, configurable: true });
      Object.defineProperty(process, "stdout", { value: sink, configurable: true });
      const { promptTty } = await import("../bin/uninstall.mjs") as any;
      assert.equal(await promptTty("  Type X to continue: "), expected, `typing ${JSON.stringify(typed)} must read back as ${expected}`);
    }
  } finally {
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
  }
});

test("a non-interactive run refuses rather than assuming consent", async () => {
  const f = await fixture(1);
  try {
    let prompted = false;
    const result = await runUninstall({}, {
      ...f.deps, interactive: false,
      prompt: async () => { prompted = true; return CONFIRMATION; },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.cancelled, "no-tty");
    assert.equal(prompted, false, "a pipe is not somebody at a keyboard");
    assert.ok(!(await gone(f.dir)));
  } finally { await f.cleanup(); }
});

/* ── the step that usually fails ─────────────────────────────────────────────
 * `npm prefix -g` is root-owned on most Linux installs, so removing the package
 * fails with EACCES for the majority of users. Throwing there would strand the
 * report after every other step already succeeded — and escalating to sudo
 * ourselves would be a destructive command quietly taking privileges it was not
 * given. Print the command; finish the sentence. */

test("a package removal that needs root is reported, not thrown", async () => {
  const f = await fixture(1);
  try {
    let printed = "";
    const exec = async (file: string, args: string[], opts: any) => {
      if (file === "npm") return { code: 243, stdout: "", stderr: "npm ERR! code EACCES\nnpm ERR! syscall unlink" };
      return execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
        (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
        (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
      );
    };
    const { exitCode, report } = await runUninstall({ yes: true }, { ...f.deps, exec, log: (l: string) => { printed += l; } });

    assert.equal(exitCode, 1, "a partial finish is not a clean exit");
    assert.equal(report.packageRemoved, false);
    assert.match(printed, /sudo npm uninstall -g nexotao/, "the one command that finishes the job must be printed");
    // Everything that did not need root still happened.
    assert.equal(report.released, 1);
    assert.ok(await gone(f.dir));
    assert.equal(await git(f.repo, "branch", "--list", "nexotao/*"), "");
  } finally { await f.cleanup(); }
});

test("--dry-run reports the plan and deletes nothing", async () => {
  const f = await fixture(2);
  try {
    let printed = "";
    const exec = async (file: string, args: string[], opts: any) => execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
      (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
      (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
    );
    const { exitCode } = await runUninstall({ dryRun: true }, { ...f.deps, exec, log: (l: string) => { printed += l; } });
    assert.equal(exitCode, 0);
    assert.match(printed, /2 worktrees released back to 1 repository/);
    assert.match(printed, new RegExp(f.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(printed, /NOT touched/);
    assert.ok(!(await gone(f.dir)));
    assert.ok(!(await gone(f.worktrees[0])));
    assert.equal(await git(f.repo, "worktree", "list").then((o) => o.split("\n").length), 3);
  } finally { await f.cleanup(); }
});

/* ── one bad worktree must not strand the rest ───────────────────────────────
 * If an unresolvable worktree aborted the run, the user would be left with the
 * damage half-done and no obvious way to finish — strictly worse than never
 * having run the command. Every failure is collected and reported; nothing
 * short-circuits. */

test("a worktree that cannot be traced does not abort the others", async () => {
  const f = await fixture(2);
  try {
    // A directory under the managed root with no git identity at all, named so
    // it is walked *first* — an implementation that gave up on the first
    // problem would then strand every healthy worktree behind it.
    const stray = path.join(f.dir, "worktrees", "abc123def4567890", "nx-0-run9");
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, "leftover.txt"), "partial checkout\n");

    const exec = async (file: string, args: string[], opts: any) => {
      if (file === "npm") return { code: 0, stdout: "", stderr: "" };
      return execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
        (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
        (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
      );
    };
    let printed = "";
    const { exitCode, report } = await runUninstall({ yes: true }, { ...f.deps, exec, log: (l: string) => { printed += l; } });

    assert.equal(exitCode, 1, "an unfinished step is reported honestly");
    assert.equal(report.released, 2, "the two healthy worktrees are still released");
    assert.match(printed, /git worktree prune/, "the user is told how to finish it themselves");
    assert.ok(await gone(stray), "its directory is still cleaned up");
    assert.equal(await git(f.repo, "branch", "--list", "nexotao/*"), "");
    assert.ok(await gone(f.dir));
  } finally { await f.cleanup(); }
});

/* ── the undo points left inside the user's repositories ─────────────────────
 * Runs no longer make a worktree; they edit the user's folder directly and
 * record a before-picture as a dangling commit under `refs/nexotao/snapshots/`.
 * That ref lives in a repository we do not own, shows up in `git for-each-ref`,
 * and travels with `git push --mirror`. Nothing collects it but us, so an
 * uninstall that skips it leaves our name inside their repo permanently.
 *
 * The two tests below cover the two ways we can find such a repository, and the
 * second matters more: after this release most projects never host a worktree
 * at all, so the disk scan finds nothing and the database is the only record of
 * where we have been writing. */

const refsUnder = async (repo: string) =>
  (await git(repo, "for-each-ref", "--format=%(refname)", "refs/nexotao/")).split("\n").filter(Boolean);

/** A real `projects` table, because that is what the uninstaller reads. The
 *  ordinary fixture writes garbage into `nexotao.sqlite` on purpose — proving
 *  an unreadable database costs nothing but ref cleanup — so a test that wants
 *  the rows has to lay them down itself.
 *
 *  The import goes through a variable because `@types/node` is pinned at ^20 and
 *  `node:sqlite` landed in 22.5: a literal specifier is a compile error against
 *  those types even though the module is there at runtime. The uninstaller has
 *  the same import and no such problem — it is `.mjs`, and nothing typechecks
 *  it. This is also why the module is optional there rather than assumed. */
const NODE_SQLITE = "node:sqlite";
type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(): Record<string, unknown>[] };
  close(): void;
};

async function writeProjectsTable(dir: string, paths: string[]) {
  const { DatabaseSync } = (await import(NODE_SQLITE)) as { DatabaseSync: DatabaseSyncCtor };
  await rm(path.join(dir, "nexotao.sqlite"), { force: true });
  const db = new DatabaseSync(path.join(dir, "nexotao.sqlite"));
  db.exec("create table projects (id text primary key, path text)");
  paths.forEach((p, i) => db.prepare("insert into projects (id, path) values (?, ?)").run(`p${i}`, p));
  db.close();
}

const passThrough = async (file: string, args: string[], opts: any) => {
  if (file === "npm") return { code: 0, stdout: "", stderr: "" };
  return execFileAsync(file, args, { encoding: "utf8", cwd: opts?.cwd }).then(
    (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
    (e: any) => ({ code: e.code ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }),
  );
};

test("snapshot refs are removed from a repository the worktree scan found", async () => {
  const f = await fixture(1);
  try {
    await git(f.repo, "update-ref", "refs/nexotao/snapshots/run-a", "HEAD");
    await git(f.repo, "update-ref", "refs/nexotao/snapshots/run-b", "HEAD");
    // A ref of the user's own, in a namespace that is not ours, one character
    // away from the prefix we match on.
    await git(f.repo, "update-ref", "refs/nexotao-mine/keep", "HEAD");

    let printed = "";
    const { exitCode, report } = await runUninstall(
      { yes: true }, { ...f.deps, exec: passThrough, log: (l: string) => { printed += l; } },
    );

    assert.equal(exitCode, 0);
    assert.equal(report.refsReleased, 2);
    assert.deepEqual(await refsUnder(f.repo), [], "both undo points are gone");
    assert.match(await git(f.repo, "for-each-ref", "--format=%(refname)", "refs/nexotao-mine/"), /keep/);
    assert.match(printed, /undo point/, "the user is told about a change inside their own repo");
    // The commits themselves become unreachable rather than being rewritten —
    // the user's history is exactly where it was.
    assert.equal(await git(f.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  } finally { await f.cleanup(); }
});

test("a repository known only from the database still has its refs swept", async () => {
  const f = await fixture(1);
  try {
    // Never hosted a worktree, so nothing under <dir>/worktrees/ names it. It is
    // also stored the way a user types a path — `~` and all — which is how the
    // rows actually look.
    const other = path.join(f.sandbox, "other-app");
    await mkdir(other, { recursive: true });
    await git(other, "init", "-b", "main");
    await git(other, "config", "user.name", "Test");
    await git(other, "config", "user.email", "test@example.test");
    await writeFile(path.join(other, "a.txt"), "x\n");
    await git(other, "add", "a.txt");
    await git(other, "commit", "-m", "chore: init");
    await git(other, "update-ref", "refs/nexotao/snapshots/run-c", "HEAD");
    await writeProjectsTable(f.dir, ["~/other-app"]);

    const { report } = await runUninstall({ yes: true }, { ...f.deps, exec: passThrough });

    assert.equal(report.refsReleased, 1);
    assert.deepEqual(await refsUnder(other), [], "the ref is gone from a repo the disk scan never saw");
    // And the folder itself is untouched — it is the user's, and only the ref
    // inside it was ever ours.
    assert.equal(await stat(path.join(other, "a.txt")).then(() => true, () => false), true);
  } finally { await f.cleanup(); }
});

/* ── a live server holding the database open ────────────────────────────────── */

test("a running app stops the uninstall before it starts", async () => {
  const f = await fixture(1);
  try {
    const result = await runUninstall({ yes: true }, { ...f.deps, probe: async () => true, exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.cancelled, "running");
    assert.ok(!(await gone(f.dir)), "nothing is deleted out from under a live process");
  } finally { await f.cleanup(); }
});

test("flags are parsed, and an unrecognised one refuses rather than guessing", async () => {
  assert.deepEqual(parseArgs(["--force", "-y", "--dry-run", "--keep-package"]), {
    force: true, yes: true, dryRun: true, keepPackage: true, help: false, unknown: [],
  });
  assert.deepEqual(parseArgs([]).unknown, []);
  assert.deepEqual(parseArgs(["--forse"]).unknown, ["--forse"]);
  // A typo must never be read as consent to a destructive default.
  let printed = "";
  const result = await runUninstall(parseArgs(["--forse"]), { log: (l: string) => { printed += l; }, probe: async () => false });
  assert.equal(result.exitCode, 2);
  assert.match(printed, /Unknown option: --forse/);
});

test("an empty machine reports nothing to do instead of an error", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "nexotao-uninstall-empty-"));
  try {
    let printed = "";
    const result = await runUninstall(
      { yes: true, keepPackage: true },
      { dir: path.join(sandbox, "data"), cacheDir: path.join(sandbox, "cache"), home: sandbox, probe: async () => false, log: (l: string) => { printed += l; } },
    );
    assert.equal(result.exitCode, 0);
    assert.match(printed, /Nothing to remove/);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test("sizes read the way a person would say them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1_500_000), "1.4 MB");
  assert.equal(formatBytes(257 * 1024 * 1024), "257 MB");
});
