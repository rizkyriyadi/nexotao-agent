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
import { killTree, signalDescendants } from "./process-tree";

export type TerminalChunk = { seq: number; stream: "out" | "err" | "meta"; data: string };

const SCROLLBACK = 4_000;
const IDLE_MS = 30 * 60_000;
const MAX_INPUT = 64_000;

/** Emitted by the shell itself after every command so we can report the exit
 *  code and the directory the next command will run in. Randomised per session
 *  so command output that happens to contain the word cannot forge one. */
function markerFor(token: string) {
  return process.platform === "win32"
    ? `echo ${token} %ERRORLEVEL% %CD%`
    : `printf '${token} %s %s\\n' "$?" "$PWD"`;
}

function shellCommand(): [string, string[]] {
  if (process.platform === "win32") return [process.env.COMSPEC || "cmd.exe", ["/q"]];
  // `sh` is the floor every POSIX box has; the user's own shell is preferred so
  // their aliases and prompt-independent rc settings apply where they exist.
  return [process.env.SHELL || "/bin/sh", ["-s"]];
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

  constructor(readonly rootId: string, cwd: string) {
    this.cwd = cwd;
    const [file, args] = shellCommand();
    this.child = spawn(file, args, {
      cwd, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
    });
    this.child.stdout?.on("data", (c: Buffer) => this.ingest("out", c.toString("utf8")));
    this.child.stderr?.on("data", (c: Buffer) => this.ingest("err", c.toString("utf8")));
    this.child.once("error", (error) => { this.push("err", `${error.message}\n`); this.finish(-1); });
    this.child.once("close", (code) => this.finish(code ?? 0));
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
    const combined = this.partial[stream] + text;
    const lines = combined.split("\n");
    this.partial[stream] = lines.pop() ?? "";
    for (const line of lines) {
      const at = line.indexOf(this.token);
      if (at === -1) { this.push(stream, `${line}\n`); continue; }
      if (at > 0) this.push(stream, line.slice(0, at));
      const [, code = "0", ...rest] = line.slice(at).trim().split(" ");
      const cwd = rest.join(" ");
      if (cwd) this.cwd = cwd;
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

  private finish(code: number) {
    if (this.exited !== null) return;
    this.exited = code;
    clearTimeout(this.idle);
    this.push("meta", JSON.stringify({ closed: code }));
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
