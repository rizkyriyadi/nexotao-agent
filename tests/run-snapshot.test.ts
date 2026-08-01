import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// `DIR` is captured on first import and decides where the scratch index lands,
// so it has to be redirected before any lib module loads.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-snapshot-"));
process.env.NEXOTAO_DATA_DIR = path.join(dir, "data");

const {
  capture, changedSince, commitsSince, dropSnapshot, fileAtSnapshot,
  listSnapshots, restore, snapshotRef, sweepSnapshots,
} = await import("../lib/run-snapshot");

const exec = promisify(execFile);
let seq = 0;

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });

/** A repository with one commit, or a plain folder when `bare` is set. Each
 *  test gets its own so a failure cannot leak into the next. */
async function folder(options: { init?: boolean; commit?: boolean } = {}) {
  seq += 1;
  const root = path.join(dir, `repo-${seq}`);
  await mkdir(root, { recursive: true });
  if (options.init === false) return root;
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@nexotao.test");
  if (options.commit === false) return root;
  await writeFile(path.join(root, "tracked.txt"), "committed\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "chore(repo): initialize fixture");
  return root;
}

test("a snapshot leaves the working tree and the user's index exactly as they were", async () => {
  const root = await folder();
  await writeFile(path.join(root, "staged.txt"), "user staged this\n");
  await git(root, "add", "staged.txt");
  await writeFile(path.join(root, "tracked.txt"), "user is mid-edit\n");
  await writeFile(path.join(root, "loose.txt"), "untracked\n");

  const statusBefore = await git(root, "status", "--porcelain");
  const headBefore = await git(root, "rev-parse", "HEAD");

  const snapshot = await capture(root, "run-1");
  assert.equal(snapshot.available, true);

  // The three surfaces the user actually looks at must be untouched. This is
  // the whole reason the capture goes through a scratch index.
  assert.equal(await git(root, "status", "--porcelain"), statusBefore);
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "staged.txt");
  // And it must not appear as a branch — that was the old design's footprint.
  assert.equal(await git(root, "branch", "--list", "nexotao/*"), "");
});

test("the snapshot holds mid-edit and untracked content, not the last commit", async () => {
  const root = await folder();
  await writeFile(path.join(root, "tracked.txt"), "edited but never committed\n");
  await writeFile(path.join(root, "loose.txt"), "never added\n");

  const snapshot = await capture(root, "run-2");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  // Byte for byte, trailing newline included. The other side of the diff is
  // read straight off disk, so a snapshot read that trimmed would report a
  // last-line change on every file that ends the way text files do.
  assert.equal(await fileAtSnapshot(root, snapshot.commit, "tracked.txt"), "edited but never committed\n");
  assert.equal(await fileAtSnapshot(root, snapshot.commit, "loose.txt"), "never added\n");
});

test("gitignored files are outside the snapshot and are left alone by a revert", async () => {
  const root = await folder();
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "bundle.js"), "// generated\n");

  const snapshot = await capture(root, "run-3");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  const tree = await git(root, "ls-tree", "-r", "--name-only", snapshot.commit);
  assert.ok(!tree.includes("dist/bundle.js"), "an ignored path must not be recorded");

  // The run rewrites it; revert must not pretend it can put it back.
  await writeFile(path.join(root, "dist", "bundle.js"), "// rebuilt by the run\n");
  await restore(root, snapshot.commit, "run-3", snapshot.head);
  assert.equal(await readFile(path.join(root, "dist", "bundle.js"), "utf8"), "// rebuilt by the run\n");
});

test("a repository with no commits still snapshots, as a parentless commit", async () => {
  const root = await folder({ commit: false });
  await writeFile(path.join(root, "first.txt"), "before any commit\n");

  const snapshot = await capture(root, "run-4");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  // `commit-tree -p HEAD` fails outright here, which is why the parent is
  // omitted entirely rather than defaulted.
  assert.equal(snapshot.head, null);
  assert.equal(await git(root, "rev-list", "--count", snapshot.commit), "1");
  assert.equal(await fileAtSnapshot(root, snapshot.commit, "first.txt"), "before any commit\n");
});

test("a plain folder is initialised so that revert is available at all", async () => {
  const root = await folder({ init: false });
  await writeFile(path.join(root, "existing.txt"), "was here before us\n");

  const snapshot = await capture(root, "run-5");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  await access(path.join(root, ".git"));
  // The pre-existing file must be recoverable too, not just what the run writes.
  assert.equal(await fileAtSnapshot(root, snapshot.commit, "existing.txt"), "was here before us\n");
});

test("a folder that cannot be a repository reports no safety net instead of failing the run", async () => {
  // A path that does not exist: `git init` fails, and `capture` must absorb it.
  const snapshot = await capture(path.join(dir, "does-not-exist"), "run-6");
  assert.equal(snapshot.available, false);
  if (snapshot.available) return;
  assert.ok(["not_a_repo", "no_git"].includes(snapshot.reason));
  assert.ok(snapshot.detail.length > 0, "the reason must be reportable to the user");
});

test("the diff sees a creation, a deletion, and a rename", async () => {
  const root = await folder();
  await writeFile(path.join(root, "doomed.txt"), "delete me\n");
  await writeFile(path.join(root, "before.txt"), "rename me, with enough content to match\n".repeat(4));
  await git(root, "add", ".");
  await git(root, "commit", "-m", "chore(repo): add fixtures");

  const snapshot = await capture(root, "run-7");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  await writeFile(path.join(root, "created.txt"), "new file\n");
  await rm(path.join(root, "doomed.txt"));
  await writeFile(path.join(root, "after.txt"), "rename me, with enough content to match\n".repeat(4));
  await rm(path.join(root, "before.txt"));

  const changes = await changedSince(root, snapshot.commit, "run-7");
  const byPath = new Map(changes.map((c) => [c.path, c]));
  // A creation is what plain `git diff <snapshot>` would miss entirely, since it
  // only reports tracked paths.
  assert.equal(byPath.get("created.txt")?.status, "A");
  assert.equal(byPath.get("doomed.txt")?.status, "D");
  assert.equal(byPath.get("after.txt")?.status, "R");
  assert.equal(byPath.get("after.txt")?.oldPath, "before.txt");
});

test("revert puts back modifications and deletions, and removes what the run created", async () => {
  const root = await folder();
  await writeFile(path.join(root, "doomed.txt"), "keep me\n");
  await git(root, "add", "doomed.txt");
  await git(root, "commit", "-m", "chore(repo): add a file to delete");

  const snapshot = await capture(root, "run-8");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  await writeFile(path.join(root, "tracked.txt"), "the run rewrote this\n");
  await rm(path.join(root, "doomed.txt"));
  await writeFile(path.join(root, "created.txt"), "the run made this\n");

  const result = await restore(root, snapshot.commit, "run-8", snapshot.head);

  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "committed\n");
  assert.equal(await readFile(path.join(root, "doomed.txt"), "utf8"), "keep me\n");
  await assert.rejects(access(path.join(root, "created.txt")), "a file the run created must not survive the revert");
  assert.deepEqual(result.removed, ["created.txt"]);
});

test("revert does not discard what the user had staged", async () => {
  const root = await folder();
  await writeFile(path.join(root, "mine.txt"), "I staged this myself\n");
  await git(root, "add", "mine.txt");

  const snapshot = await capture(root, "run-9");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  await writeFile(path.join(root, "tracked.txt"), "run output\n");
  await restore(root, snapshot.commit, "run-9", snapshot.head);

  // `git checkout <tree> -- .` writes the index by default; losing a staged
  // entry the user set up by hand, with no message, is the failure this guards.
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "mine.txt");
});

test("revert leaves commits made during the run in history, and reports them", async () => {
  const root = await folder();
  const snapshot = await capture(root, "run-10");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;

  // The agent is allowed to commit now, so this is an ordinary run.
  await writeFile(path.join(root, "feature.txt"), "agent work\n");
  await git(root, "add", "feature.txt");
  await git(root, "commit", "-m", "feat: add a feature");
  const headAfterCommit = await git(root, "rev-parse", "HEAD");

  const result = await restore(root, snapshot.commit, "run-10", snapshot.head);

  assert.equal(await git(root, "rev-parse", "HEAD"), headAfterCommit, "revert must not rewrite history");
  assert.equal(result.commits?.count, 1);
  assert.equal(result.commits?.from, snapshot.head);
  // The file content is back even though the commit that added it remains — the
  // asymmetry the UI has to explain.
  await assert.rejects(access(path.join(root, "feature.txt")));
});

test("commitsSince reports nothing when the run committed nothing", async () => {
  const root = await folder();
  const snapshot = await capture(root, "run-11");
  assert.equal(snapshot.available, true);
  if (!snapshot.available) return;
  await writeFile(path.join(root, "tracked.txt"), "edited, not committed\n");
  assert.equal(await commitsSince(root, snapshot.head), null);
});

test("a snapshot the caller still needs survives the sweep, and the rest are collected", async () => {
  const root = await folder();
  await capture(root, "run-keep");
  await capture(root, "run-drop");
  assert.equal((await listSnapshots(root)).length, 2);

  // maxAge 0 makes every unheld ref collectable, which is what the caller does
  // for a project whose reviews are all settled.
  const dropped = await sweepSnapshots(root, new Set(["run-keep"]), 0);
  assert.deepEqual(dropped, ["run-drop"]);
  const remaining = await listSnapshots(root);
  assert.deepEqual(remaining.map((s) => s.runId), ["run-keep"]);
  // Held refs stay resolvable, which is what keeps Revert on offer.
  assert.ok(await git(root, "rev-parse", "--verify", snapshotRef("run-keep")));
});

test("a young snapshot is kept even when nobody is holding it", async () => {
  const root = await folder();
  await capture(root, "run-young");
  assert.deepEqual(await sweepSnapshots(root, new Set(), 60_000), []);
  assert.equal((await listSnapshots(root)).length, 1);
});

test("each run gets its own snapshot, so a follow-up cannot strand the first", async () => {
  const root = await folder();
  const first = await capture(root, "run-a");
  await writeFile(path.join(root, "tracked.txt"), "after the first run\n");
  const second = await capture(root, "run-b");
  assert.equal(first.available && second.available, true);
  if (!first.available || !second.available) return;

  assert.notEqual(first.commit, second.commit);
  // Both remain addressable. A per-issue column would have had the second run
  // overwrite the first, making the first run's work permanently unrevertable.
  assert.equal(await fileAtSnapshot(root, first.commit, "tracked.txt"), "committed\n");
  assert.equal(await fileAtSnapshot(root, second.commit, "tracked.txt"), "after the first run\n");
});

test("dropping a snapshot is idempotent and leaves the repository usable", async () => {
  const root = await folder();
  await capture(root, "run-gone");
  await dropSnapshot(root, "run-gone");
  await dropSnapshot(root, "run-gone");
  assert.deepEqual(await listSnapshots(root), []);
  assert.equal(await git(root, "status", "--porcelain"), "");
});
