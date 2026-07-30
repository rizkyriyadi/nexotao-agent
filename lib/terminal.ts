// A shell the user can drive, in the folder they are looking at.
//
// The agent has had `bash` from the start; the person watching it has had
// nothing. When a run leaves the project in a state worth checking — a build to
// re-run, a `git status` to read, a dev server to start — the only options were
// to leave the app for a terminal, or to ask the agent to run the command and
// read the answer back through a transcript.
//
// Deliberately not a PTY. `node-pty` is a native addon, and this ships as an
// npm package people install with one command onto machines that may have no
// compiler; a terminal that makes `npm i -g nexotao` fail is worse than no
// terminal. What you get instead is a persistent piped shell: `cd` and exported
// variables survive between commands because it really is one long-lived shell
// process, but there is no tty, so full-screen programs (vim, top) and password
// prompts will not work. Those are worth naming in the UI rather than
// discovering.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { killTree, signalDescendants } from "./process-tree";

export type TerminalChunk = { seq: number; stream: "out" | "err" | "meta"; data: string };

const SCROLLBACK = 4_000;
const IDLE_MS = 30 * 60_000;
const REAP_MS = 60_000;
const MAX_INPUT = 64_000;

/** Emitted by the shell itself after every command so we can report the exit
 *  code and the directory the next command will run in. Randomised per session
 *  so command output that happens to contain the word cannot forge one.
 *
 *  The `@` on the Windows line is not decoration. `cmd /q` starts with echo off,
 *  but echo is session state the user can change — one `echo on`, or a `.bat`
 *  that turns it on and does not turn it back, and cmd starts echoing the marker
 *  *command* before running it. That echo is the literal text `%ERRORLEVEL%` and
 *  `%CD%`, unexpanded, which parses as a marker reporting a non-numeric exit code
 *  and a current directory of `%CD%`. `@` suppresses the echo of its own line
 *  whatever ECHO is set to; the numeric guard in `ingest` covers the rest. */
function markerFor(token: string) {
  return process.platform === "win32"
    ? `@echo ${token} %ERRORLEVEL% %CD%`
    : `printf '${token} %s %s\\n' "$?" "$PWD"`;
}

function runnable(file: string) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/** Strip the control characters a shell writes for a terminal we do not have.
 *
 *  `@prompt $H` is a lone backspace, and cmd emits a form feed for `cls`. In a
 *  real terminal they move the cursor; in a plain-text log they are invisible
 *  junk that travels with any text the user copies out. Tabs and newlines stay —
 *  those are content. */
function clean(line: string) {
  return line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Pick a shell that is actually on this machine.
 *
 *  `process.env.SHELL` is a *preference*, not a promise. It is whatever was set
 *  in the environment that launched the server, and that environment is often
 *  not the one the shell lives in: a macOS user's `SHELL=/bin/zsh` inherited by
 *  a Linux container, a launchd or systemd unit carrying a stale value, a Nix or
 *  Homebrew shell that has since been removed. Spawning it unchecked turns a
 *  missing file into `spawn /bin/zsh ENOENT` and a panel with no shell at all —
 *  for a variable we only ever wanted as a nicety.
 *
 *  So the preference is tried, then the shells that are actually present, and
 *  `/bin/sh` is the floor every POSIX box has. */
function shellCommand(): [string, string[]] {
  if (process.platform === "win32") {
    // `COMSPEC` is the same kind of promise `SHELL` is — a variable that usually
    // says `C:\Windows\system32\cmd.exe` and occasionally says something a
    // corporate login script set years ago. Checking it costs one `access` call
    // and saves the panel from the Windows spelling of the bug above.
    // `/d` is the one that is easy to miss. Without it cmd runs whatever is in
    // the `Command Processor\AutoRun` registry key before accepting input, and
    // that key is where Anaconda, clink and corporate login scripts install
    // themselves. Their banner text lands in the user's log as if a command had
    // printed it, and an AutoRun that ends with a `cd` moves the shell out of
    // the folder the panel is showing.
    const args = ["/d", "/q"];
    const comspec = process.env.COMSPEC;
    if (comspec && runnable(comspec)) return [comspec, args];
    const root = process.env.SystemRoot || "C:\\Windows";
    const fallback = `${root}\\System32\\cmd.exe`;
    return [runnable(fallback) ? fallback : "cmd.exe", args];
  }
  const preferred = process.env.SHELL;
  const candidates = [preferred, "/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/sh"].filter((file): file is string => Boolean(file));
  return [candidates.find(runnable) ?? "/bin/sh", ["-s"]];
}

/** The folder to start in, and a note when it is not the one that was asked for.
 *
 *  A cwd that no longer exists fails the spawn with `spawn <shell> ENOENT` —
 *  naming the shell, not the folder, because that is the file `execve` reports.
 *  Read literally it sends everyone hunting for a missing shell binary that is
 *  sitting right there. It happens for an ordinary reason: the panel opens on a
 *  run's worktree, and a worktree is removed when its run is cleaned up.
 *
 *  Falling back to the home directory keeps the terminal usable, and the note
 *  says which folder went missing so the substitution is visible rather than a
 *  shell that silently starts somewhere else. */
function startDirectory(requested: string): [string, string | null] {
  try {
    if (statSync(requested).isDirectory()) return [requested, null];
  } catch { /* fall through to the note below */ }
  return [homedir(), `${requested} no longer exists — opened your home folder instead.`];
}

export class TerminalSession {
  readonly id = randomUUID();
  readonly token = `__nxt_${randomUUID().slice(0, 8)}__`;
  cwd: string;
  exited: number | null = null;

  private child: ChildProcess | null = null;
  private buffer: TerminalChunk[] = [];
  private seq = 0;
  private listeners = new Set<(chunk: TerminalChunk) => void>();
  private idle: NodeJS.Timeout;
  private partial = { out: "", err: "" };
  /** Swallowing cmd.exe's startup banner: true until its marker arrives. */
  private silent = false;

  constructor(readonly rootId: string, requested: string) {
    const [cwd, note] = startDirectory(requested);
    this.cwd = cwd;
    const [file, args] = shellCommand();
    if (note) this.push("meta", JSON.stringify({ note }));
    this.child = spawn(file, args, {
      cwd, detached: process.platform !== "win32",
      // Node defaults this to false, and a console window then appears whenever
      // the host has no console of its own to inherit — a service, a GUI launch.
      // The user gets a black window they did not ask for, in front of the app,
      // for a shell whose entire output they are already reading in the panel.
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
    });
    this.child.stdout?.on("data", (c: Buffer) => this.ingest("out", c.toString("utf8")));
    this.child.stderr?.on("data", (c: Buffer) => this.ingest("err", c.toString("utf8")));
    // `spawn <file> ENOENT` names the shell whether the shell or the *folder* is
    // the thing that is missing, so say which in plain words rather than passing
    // the raw errno message to someone who then goes looking for a file that is
    // not the problem.
    this.child.once("error", (error) => {
      const reason = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `Could not start a shell (tried ${file}).`
        : `Could not start a shell: ${error.message}`;
      this.push("err", `${reason}\n`);
      this.finish(-1);
    });
    this.child.once("close", (code) => this.finish(code ?? 0));
    // cmd.exe greets a new session with its version and copyright banner, and
    // `/q` does not suppress it — there is no `/nologo`. It would arrive in the
    // panel looking like output from a command the user never ran. Rather than
    // model the banner's text, which is localised and changes between Windows
    // builds, the shell is asked to mark where its own preamble ends: everything
    // before that first marker is the banner and is dropped. `@prompt $H` turns
    // the prompt into a lone backspace, so a user who later types `echo on` gets
    // their echo without `C:\dir>` threaded through the log.
    if (process.platform === "win32") {
      this.silent = true;
      this.child.stdin?.write(`@echo off\n@prompt $H\n${markerFor(this.token)}\n`);
    }
    this.idle = setTimeout(() => this.dispose(), IDLE_MS);
    this.idle.unref?.();
  }

  get alive() { return this.exited === null; }

  /** Split on newlines, then look for the marker *anywhere* in each line.
   *
   *  Anchoring it to the start of the line looks right and fails on the most
   *  ordinary output there is: a command whose last write has no trailing
   *  newline (`printf` without `\n`, a progress counter, most REPL banners).
   *  The shell then writes the marker onto that same line, so the line reads
   *  `Building…__nxt_1a2b__ 0 /repo` — no exit code is reported, the panel keeps
   *  showing a spinner for a command that finished, and the raw token is printed
   *  to the user. Splitting the line at the marker recovers both halves. */
  private ingest(stream: "out" | "err", text: string) {
    // `\r\n` is dropped to `\n` first. cmd.exe emits CRLF, and splitting on
    // `\n` alone leaves a carriage return on the end of every line — invisible
    // in the log but real in the text, so a copied command carries a stray CR
    // and anything comparing the output to a string fails for no visible reason.
    const combined = (this.partial[stream] + text).replace(/\r\n/g, "\n");
    const lines = combined.split("\n");
    this.partial[stream] = lines.pop() ?? "";
    for (const line of lines) {
      const at = line.indexOf(this.token);
      // Still inside cmd.exe's startup banner: drop the line, and when the
      // preamble's own marker arrives, drop that too and start reporting.
      if (this.silent) {
        if (at !== -1) this.silent = false;
        continue;
      }
      if (at === -1) { this.push(stream, `${clean(line)}\n`); continue; }
      if (at > 0) this.push(stream, clean(line.slice(0, at)));
      const [, code = "0", ...rest] = line.slice(at).trim().split(" ");
      const cwd = rest.join(" ");
      // An unexpanded `%CD%` is the shape a mis-echoed cmd.exe marker takes, and
      // believing it would point the folder chip — and the next shell opened on
      // this root — at a directory spelled `%CD%`. A cwd we cannot vouch for is
      // better left as the last one we could.
      if (cwd && !cwd.includes("%")) this.cwd = cwd;
      this.push("meta", JSON.stringify({ exit: Number(code) || 0, cwd: this.cwd }));
    }
    // A prompt-less read (`read -p`, a password) never ends in a newline, so
    // holding the tail back forever would hide it. Flush it as-is; the next
    // chunk continues from where it left off.
    if (this.partial[stream].length > 2_000) {
      this.push(stream, this.partial[stream]);
      this.partial[stream] = "";
    }
  }

  private push(stream: TerminalChunk["stream"], data: string) {
    const chunk: TerminalChunk = { seq: ++this.seq, stream, data };
    this.buffer.push(chunk);
    if (this.buffer.length > SCROLLBACK) this.buffer.splice(0, this.buffer.length - SCROLLBACK);
    for (const listener of this.listeners) { try { listener(chunk); } catch { /* a dead subscriber must not stop the rest */ } }
  }

  /** Run a command line. Echoed first so the scrollback reads like a terminal,
   *  then followed by the marker so we learn the exit code and the new cwd. */
  run(command: string) {
    if (!this.alive || !this.child?.stdin?.writable) return false;
    const line = command.slice(0, MAX_INPUT);
    this.push("meta", JSON.stringify({ prompt: this.cwd, command: line }));
    this.child.stdin.write(`${line}\n${markerFor(this.token)}\n`);
    this.touch();
    return true;
  }

  /** Raw stdin, for a program already waiting on input. */
  write(data: string) {
    if (!this.alive || !this.child?.stdin?.writable) return false;
    this.child.stdin.write(data.slice(0, MAX_INPUT));
    this.touch();
    return true;
  }

  /** Ctrl-C: stop the running command, keep the shell.
   *
   *  Signalling the process *group* (`kill -SIGINT -pid`) is the obvious move
   *  and it is wrong here. This shell is its own group leader, and with no tty
   *  it has no line discipline to read SIGINT as "abandon this line" — it just
   *  dies, taking the user's cwd and exports with it. So the signal goes to the
   *  descendants only; the shell survives and reports 130, as a terminal does. */
  interrupt() {
    if (!this.alive || !this.child?.pid) return false;
    signalDescendants(this.child.pid, "SIGINT");
    this.touch();
    return true;
  }

  since(cursor: number) { return this.buffer.filter((chunk) => chunk.seq > cursor); }

  subscribe(listener: (chunk: TerminalChunk) => void) {
    this.listeners.add(listener);
    this.touch();
    return () => { this.listeners.delete(listener); };
  }

  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dispose(), IDLE_MS);
    this.idle.unref?.();
  }

  /** A dead session is kept around briefly, then dropped.
   *
   *  Kept, because the client is usually mid-reconnect when the shell dies and
   *  the last thing it wrote — the error that explains *why* — is only in this
   *  buffer; a session deleted the instant it exits answers that reconnect with
   *  "that shell is gone" and the user never learns what happened. Dropped,
   *  because each one holds a scrollback of up to `SCROLLBACK` chunks and a
   *  server that runs for weeks would otherwise accumulate one per shell that
   *  ever exited. */
  private finish(code: number) {
    if (this.exited !== null) return;
    this.exited = code;
    clearTimeout(this.idle);
    this.push("meta", JSON.stringify({ closed: code }));
    const reap = setTimeout(() => { this.listeners.clear(); sessions.delete(this.id); }, REAP_MS);
    reap.unref?.();
  }

  dispose() {
    if (this.child?.pid) killTree(this.child.pid, () => this.child?.kill("SIGTERM"));
    this.finish(this.exited ?? 0);
    this.listeners.clear();
    sessions.delete(this.id);
  }
}

const sessions = new Map<string, TerminalSession>();

export function getSession(id: string) {
  const session = sessions.get(id);
  return session && session.alive ? session : session ?? null;
}

/** One shell per workspace folder. Reopening the panel rejoins the shell that is
 *  already there — with its cwd, its exports, and its scrollback — rather than
 *  starting a fresh one that has forgotten where the user was. */
export function openSession(rootId: string, cwd: string) {
  for (const session of sessions.values()) {
    if (session.rootId === rootId && session.alive) return session;
  }
  const session = new TerminalSession(rootId, cwd);
  sessions.set(session.id, session);
  return session;
}

export function disposeAllSessions() {
  for (const session of [...sessions.values()]) session.dispose();
}
