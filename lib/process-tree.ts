// Killing a spawned process *and* everything it spawned.
//
// Both places that run a foreign command — the code indexer and the agent's
// shell tool — had the same line:
//
//     process.kill(platform === "win32" ? child.pid : -child.pid, "SIGTERM")
//
// The POSIX half is right: `detached: true` puts the child in its own process
// group, and the negative pid signals the whole group, so workers die with their
// parent. The Windows half only looks symmetrical. Windows has no process
// groups to signal, `detached` is therefore false, and a bare pid kills exactly
// one process — the direct child. Every worker it forked is orphaned and keeps
// running, holding its memory, unreachable by the timeout that was supposed to
// reclaim it.
//
// That is not a tidiness problem. A tree-sitter indexer pointed at a Flutter
// repo forks a worker per core over `build/`, `.dart_tool/`, `ios/`, `android/`
// — generated output that dwarfs the source. When the 600s timeout fires and
// reclaims only the supervisor, the workers survive it. Boot runs this again.
// The reported end state was Windows error `0xC000012D` — STATUS_COMMITMENT_LIMIT,
// the whole machine out of committed memory — after which the shell could no
// longer fork at all: `CreateProcessW failed`, and git dying mid-`worktree add`
// with "Could not reset index file to revision 'HEAD'" because it could not get
// memory to write a five-thousand-entry index.
//
// `taskkill /T` is the Windows equivalent of signalling a process group: it
// walks the child list the kernel already maintains and terminates the tree.
import { spawn } from "node:child_process";

/**
 * Terminate `pid` and every process it spawned. Never throws — callers are
 * timeout and abort handlers, where the process is often already gone and a
 * throw would take down the handler rather than the child.
 *
 * `fallback` is the caller's own `child.kill`, used when the tree kill cannot
 * be issued at all. It reaches one process rather than none.
 */
export function killTree(pid: number | undefined, fallback?: () => void) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      // /T the tree, /F because a Node worker mid-parse does not service the
      // polite request. Output is discarded: "process not found" is the normal
      // race with a child that just exited, not something to report.
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      // taskkill absent (stripped-down Windows, PATH oddity) still leaves the
      // direct child killable.
      killer.once("error", () => { try { fallback?.(); } catch { /* already gone */ } });
    } catch {
      try { fallback?.(); } catch { /* already gone */ }
    }
    return;
  }
  // Negative pid = the process group created by `detached: true`.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { fallback?.(); } catch { /* already gone */ }
  }
}
