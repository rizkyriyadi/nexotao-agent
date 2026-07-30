import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TerminalSession, disposeAllSessions, getSession, openSession, type TerminalChunk } from "../lib/terminal";

/* These run a real shell. `node-pty` is deliberately not a dependency (a native
 * addon would break `npm i -g nexotao` on any machine without a compiler), so
 * what is under test is a piped long-lived shell — and the two properties that
 * buys the user are exactly what a piped shell makes easy to get wrong. */

const skip = process.platform === "win32";

/** The session speaks in chunks, not promises. Waiting on a predicate over the
 *  accumulated output is the only honest way to test it — a fixed sleep either
 *  flakes on a slow box or wastes a second on a fast one. */
function collector(session: TerminalSession) {
  const chunks: TerminalChunk[] = [];
  session.subscribe((chunk) => chunks.push(chunk));
  return {
    chunks,
    text: () => chunks.filter((c) => c.stream !== "meta").map((c) => c.data).join(""),
    meta: () => chunks.filter((c) => c.stream === "meta").map((c) => JSON.parse(c.data)),
    async until(predicate: () => boolean, ms = 15_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    },
  };
}

test("the shell is one process, so cd and exports survive between commands", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    /* The whole reason this is a long-lived piped shell rather than a spawn per
     * command: a terminal where `cd build` is forgotten by the next line is not
     * a terminal, it is a command runner wearing one. */
    session.run("mkdir -p nested && cd nested && export NEXOTAO_MARK=kept");
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit !== undefined)), "the first command reported");

    session.run("printf 'pwd=%s mark=%s\\n' \"$(basename \"$PWD\")\" \"$NEXOTAO_MARK\"");
    assert.ok(await sink.until(() => sink.text().includes("pwd=")), "the second command produced output");
    assert.match(sink.text(), /pwd=nested mark=kept/);

    // And the reported cwd follows, so the prompt shows where the next command
    // will actually run rather than where the shell started.
    assert.equal(path.basename(session.cwd), "nested");
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("exit codes and stderr are reported, not silently folded into the output", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    // In a subshell: a bare `exit` is the user closing their own terminal, and
    // the shell obeying that is correct behaviour, not a case to test around.
    session.run("sh -c \"printf 'to stderr\\n' >&2; exit 3\"");
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit === 3)), "exit 3 was reported");
    // Coloured red in the UI on the strength of this — if stderr arrived as
    // ordinary output, a failing build would read like a passing one.
    assert.ok(sink.chunks.some((c) => c.stream === "err" && c.data.includes("to stderr")));
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

/* A marker is how the exit code and cwd get back out of a shell with no tty. If
 * output that merely *contains* the marker were believed, any command printing
 * it — `cat` of a log, `grep` over this very test file — could forge an exit
 * code and, worse, move the reported cwd somewhere the user is not. The token is
 * randomised per session precisely so that cannot be arranged from outside. */
test("command output cannot forge the exit-code marker", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const first = new TerminalSession("root", dir);
  const second = new TerminalSession("root", dir);
  const sink = collector(first);
  try {
    assert.notEqual(first.token, second.token, "each session gets its own token");
    // One session's token is not the other's, so this is text, not a marker.
    first.run(`printf '${second.token} 42 /somewhere/else\\n'`);
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit !== undefined)), "the command finished");
    assert.ok(sink.chunks.some((c) => c.stream === "out" && c.data.includes(second.token)), "printed as ordinary output");
    assert.ok(!sink.meta().some((m) => m.exit === 42), "no forged exit code");
    assert.equal(first.cwd, dir, "and the cwd did not move");
  } finally {
    first.dispose(); second.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a marker glued to the tail of the previous line is still recognised", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    /* `printf` without a trailing newline is ordinary (`echo -n`, a progress
     * line, most REPL banners). The shell then writes the marker onto the same
     * line, and a naive line-split over one chunk would swallow both: no exit
     * code, and the prompt hangs on a command that has already finished. */
    session.run("printf 'no trailing newline'");
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit !== undefined)), "the exit code still arrived");
    assert.match(sink.text(), /no trailing newline/);
    assert.ok(!sink.text().includes(session.token), "and the marker itself is never shown to the user");
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

/* Ctrl-C is the escape hatch for a command that will not end on its own — a dev
 * server, a runaway build. The obvious implementation signals the process group,
 * and that kills the shell too: this shell is its own group leader, and with no
 * tty it has no line discipline to read SIGINT as "abandon this line". The user
 * pressed stop on a dev server and lost the terminal, along with the directory
 * they had navigated to and everything they had exported. */
test("interrupting stops the command and leaves the shell standing", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    session.run("cd / && export NEXOTAO_MARK=kept");
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit !== undefined)), "the setup command ran");

    session.run("sleep 30");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(session.interrupt(), "the interrupt was issued");
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit === 130), 10_000), "the command was interrupted");

    // The shell is still there, still where the user left it.
    assert.ok(session.alive, "the shell survived its own Ctrl-C");
    session.run("printf 'pwd=%s mark=%s\\n' \"$PWD\" \"$NEXOTAO_MARK\"");
    assert.ok(await sink.until(() => sink.text().includes("pwd=")), "and still accepts commands");
    assert.match(sink.text(), /pwd=\/ mark=kept/);
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a folder rejoins its shell rather than starting a fresh one", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  try {
    const first = openSession("root-a", dir);
    const sink = collector(first);
    first.run("cd / && export NEXOTAO_MARK=kept");
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit !== undefined)), "the command ran");

    /* Closing the panel and opening it again is not a new terminal. If it were,
     * the user would lose their cwd, their exports and their scrollback every
     * time they glanced at a file — which is most of what this panel is for. */
    const again = openSession("root-a", dir);
    assert.equal(again.id, first.id);
    assert.ok(again.since(0).length > 0, "with its scrollback intact");

    // A different folder is a different shell, though.
    const other = openSession("root-b", dir);
    assert.notEqual(other.id, first.id);
    assert.equal(getSession(first.id)?.id, first.id);
  } finally {
    disposeAllSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a disposed shell is gone from the registry and refuses further input", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  try {
    const session = openSession("root-c", dir);
    session.dispose();
    assert.equal(getSession(session.id), null, "no leaked session for a later request to reach");
    assert.equal(session.run("echo still here"), false);
    assert.equal(session.write("x"), false);
    // Reopening the same folder now yields a genuinely new shell.
    assert.notEqual(openSession("root-c", dir).id, session.id);
  } finally {
    disposeAllSessions();
    await rm(dir, { recursive: true, force: true });
  }
});
