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
import { execFile, spawn } from "node:child_process";

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

/**
 * The direct children of `pid` on Windows, asked for two ways.
 *
 * `wmic` was the obvious tool and it is being taken away: deprecated since
 * Windows 10 21H1, and absent from a clean Windows 11 24H2 install. A lookup
 * that only knows `wmic` returns nothing there — silently, because "no such
 * command" and "no children" both arrive as an error we are obliged to swallow.
 * The visible symptom would be Ctrl-C doing nothing at all on the newest
 * Windows, which is the one place we cannot test from here.
 *
 * So PowerShell's CIM query is tried first (present on every supported Windows)
 * and `wmic` is the fallback for the older boxes where PowerShell is locked down
 * by execution policy. Both print one pid per line; anything that is not a
 * number is a header or a blank and is filtered out.
 */
function windowsChildren(pid: number, done: (children: number[]) => void) {
  // `pid` is a number from `child.pid`, never user text, so it cannot carry a
  // quote out of the `-Filter` string — but the whole file's contract is that a
  // timeout handler never dies, so a spawn that fails outright ends in an empty
  // list rather than an exception thrown from inside someone's `catch`.
  const parse = (stdout: string) => stdout.split(/\r?\n/).map((row) => Number(row.trim())).filter(Boolean);
  const viaWmic = () => {
    try {
      execFile("wmic", ["process", "where", `ParentProcessId=${pid}`, "get", "ProcessId"], (error, stdout) => {
        done(error ? [] : parse(stdout));
      });
    } catch { done([]); }
  };
  try {
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`,
    ], (error, stdout) => {
      const children = error ? [] : parse(stdout);
      if (children.length) return done(children);
      viaWmic();
    });
  } catch { viaWmic(); }
}

/**
 * Signal everything `pid` spawned, but *not* `pid` itself.
 *
 * Ctrl-C in the terminal panel is this, and it cannot be `killTree`. A shell
 * started with `detached: true` is the leader of its own process group, so
 * `process.kill(-pid, "SIGINT")` reaches the running command *and the shell*,
 * and a shell with no tty has no line discipline to treat SIGINT as "abandon
 * this line" — it simply dies. The user pressed Ctrl-C to stop a dev server and
 * instead lost the shell, with the cwd they had navigated to and every variable
 * they had exported.
 *
 * Walking the tree by ppid and signalling only the descendants leaves the shell
 * standing, and it still reports the interrupted command's exit code (130) the
 * way a real terminal does.
 *
 * Never throws, for the same reason as `killTree`: the process is often already
 * gone by the time the user's click arrives.
 */
export function signalDescendants(pid: number | undefined, signal: NodeJS.Signals = "SIGINT") {
  if (!pid) return;
  if (process.platform === "win32") {
    // `taskkill /T` kills the tree *including* the pid it is given, so naming the
    // shell here would kill the shell — the exact bug this function exists to
    // avoid, just spelled in Windows. Ask for the shell's direct children and
    // kill each of their trees instead, leaving the shell itself standing.
    windowsChildren(pid, (children) => {
      for (const child of children) {
        execFile("taskkill", ["/pid", String(child), "/T", "/F"], () => { /* already gone is normal */ });
      }
    });
    return;
  }
  execFile("ps", ["-eo", "pid=,ppid="], (error, stdout) => {
    if (error) return;
    const children = new Map<number, number[]>();
    for (const line of stdout.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!child || !parent) continue;
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    // Depth-first from the shell, collecting every descendant. Deepest first on
    // the way back out so a supervisor cannot notice a worker die and restart it.
    const found: number[] = [];
    const stack = [pid];
    while (stack.length) {
      for (const child of children.get(stack.pop()!) ?? []) { found.push(child); stack.push(child); }
    }
    for (const target of found.reverse()) {
      try { process.kill(target, signal); } catch { /* exited on its own */ }
    }
  });
}
