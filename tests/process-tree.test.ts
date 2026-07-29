import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/* Killing a command means killing what it spawned.

   This file exists because of a crash report from a Windows user: the app died
   with `0xC000012D` — STATUS_COMMITMENT_LIMIT, the whole machine out of
   committed memory — after which Git Bash could no longer fork at all
   (`CreateProcessW failed`) and git died mid-`worktree add` with "Could not
   reset index file to revision 'HEAD'". The cause was not the size of their
   repository. It was that every worker the code indexer forked over that
   repository outlived the timeout meant to reclaim it, on every boot.

   The kill path is genuinely platform-specific, so these tests are split: the
   behaviour that can be observed on this machine is observed, and the Windows
   branch — which cannot be — is asserted structurally rather than pretended at.
   A test that silently skips the only platform that had the bug would be worse
   than no test. */

const { killTree } = await import("../lib/process-tree");

/* Why: this is the actual regression, and on POSIX it is directly observable.
   A shell that forks a child and exits leaves that child running; only
   signalling the process *group* reaches it. Killing the direct pid alone —
   what the old code did on Windows — leaves the grandchild holding its memory
   with nothing left that can reclaim it. */
test("a process killed by the tree takes its children with it", { skip: process.platform === "win32" }, async () => {
  // The parent forks a long sleep and waits. Killing only the parent's pid
  // would leave the sleep running; signalling the group ends both.
  const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const grandchildPid = await new Promise<number>((resolve) => {
    child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  });
  assert.ok(grandchildPid > 0, "the fixture reported its grandchild");
  // `kill(pid, 0)` probes for existence without signalling.
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(grandchildPid), "the grandchild is running before the kill");

  killTree(child.pid);

  // The signal is delivered asynchronously; poll rather than assume a duration.
  for (let i = 0; i < 50 && alive(grandchildPid); i++) await delay(20);
  assert.ok(!alive(grandchildPid), "the grandchild died with its parent, not after it");
});

/* Why: the report came from Windows, where the old code passed a bare positive
   pid — syntactically fine, semantically one process. There are no process
   groups to signal there, so the tree has to be walked explicitly, and
   `taskkill /T` is the only thing that does it. Asserting the command we would
   issue is weaker than running it, and it is the strongest claim available from
   a Linux CI box; without it the Windows branch has no coverage at all. */
test("on Windows the whole tree is targeted, not a single pid", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/process-tree.ts", import.meta.url), "utf8"));

  assert.match(source, /taskkill/, "the Windows branch walks the tree");
  assert.match(source, /"\/T"/, "/T is what makes taskkill recursive — without it this is the old bug");
  assert.doesNotMatch(
    source,
    /process\.kill\(\s*process\.platform === "win32" \? child\.pid : -child\.pid/,
    "the old bare-pid-on-Windows form is gone",
  );
});

/* Why: every caller is a timeout or abort handler. A process that already
   exited is the common case there — the race is normal, not exceptional — and
   a throw would take down the handler instead of the child. */
test("killing something already gone is not an error", () => {
  assert.doesNotThrow(() => killTree(undefined));
  // A pid that cannot exist: killTree must swallow the ESRCH, and fall back.
  let fellBack = false;
  assert.doesNotThrow(() => killTree(0x7ffffff0, () => { fellBack = true; }));
  if (process.platform !== "win32") {
    assert.ok(fellBack, "an unsignalable pid falls back to the caller's own kill");
  }
});
