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
  // Replay first, then tail — the same order the SSE route uses, and for the
  // same reason: a session can push before anyone has subscribed (the note about
  // a substituted folder is written in the constructor), and a collector that
  // only tails would never see it.
  const chunks: TerminalChunk[] = [...session.since(0)];
  session.subscribe((chunk) => { if (!chunks.some((seen) => seen.seq === chunk.seq)) chunks.push(chunk); });
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

/* `SHELL` is a preference inherited from whatever launched the server, and it is
 * routinely a lie: a macOS `SHELL=/bin/zsh` carried into a Linux container, a
 * stale systemd unit, a Homebrew shell since removed. Spawning it unchecked
 * turned that into `spawn /bin/zsh ENOENT` and a panel with no shell at all —
 * the whole feature lost to a variable we only ever wanted as a nicety. */
test("a SHELL that is not on this machine falls back instead of failing", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const previous = process.env.SHELL;
  process.env.SHELL = "/nonexistent/zsh";
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    session.run("printf 'shell=%s\\n' alive");
    assert.ok(await sink.until(() => sink.text().includes("shell=alive")), "a working shell was found anyway");
    assert.ok(session.alive, "and it is still running");
    // The name of the shell we could not start is never shown as a bare errno.
    assert.ok(!sink.text().includes("ENOENT"), "no raw spawn error reached the user");
  } finally {
    if (previous === undefined) delete process.env.SHELL; else process.env.SHELL = previous;
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

/* A folder that has been deleted fails the spawn with `spawn <shell> ENOENT` —
 * naming the shell, because that is the file `execve` reports. Read literally it
 * sends the user hunting for a missing shell binary that is sitting right there.
 * And it happens for an entirely ordinary reason: the panel opens on a run's
 * worktree, and a worktree is removed when its run is cleaned up. */
test("a folder that has been deleted opens a shell somewhere real, and says so", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  await rm(dir, { recursive: true, force: true });
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    assert.ok(await sink.until(() => sink.meta().some((m) => typeof m.note === "string")), "the substitution was reported");
    assert.match(sink.meta().find((m) => m.note)!.note, /no longer exists/);
    session.run("printf 'ok\\n'");
    assert.ok(await sink.until(() => sink.text().includes("ok")), "and the shell works");
    assert.ok(session.alive);
  } finally {
    session.dispose();
  }
});

/* cmd.exe ends every line with CRLF. Splitting on `\n` alone leaves the carriage
 * return on the end of each line, where it is invisible in the panel and real in
 * the text: a copied command carries a stray CR into the next shell, and anything
 * comparing output to a string fails for a reason nobody can see. Windows is the
 * platform that makes this routine, but any command emitting CRLF hits it, which
 * is what lets this be tested from a POSIX box at all. */
test("carriage returns from CRLF output do not survive into the log", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    session.run("printf 'first\\r\\nsecond\\r\\n'");
    assert.ok(await sink.until(() => sink.text().includes("second")), "the output arrived");
    assert.ok(!sink.text().includes("\r"), "no carriage return reached the user");
    assert.match(sink.text(), /first\nsecond\n/);
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

/* On Windows the marker is `@echo <token> %ERRORLEVEL% %CD%`, and cmd.exe expands
 * those two only when it runs the line. If echo is ever turned back on — one
 * stray `echo on`, a `.bat` that does not restore it — cmd prints the command
 * *before* running it, unexpanded, and a marker arrives claiming the current
 * directory is literally `%CD%`. Believing it would point the folder chip, and
 * every shell later opened on this root, at a directory that cannot exist. */
test("a marker carrying an unexpanded variable does not move the reported folder", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    session.run(`printf '${session.token} 0 %%CD%%\\n'`);
    assert.ok(await sink.until(() => sink.meta().some((m) => m.exit !== undefined)), "the command finished");
    assert.equal(session.cwd, dir, "the folder is still the real one");
    assert.ok(!sink.meta().some((m) => String(m.cwd).includes("%")), "and no meta reported a bogus folder");
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

/* On Windows the shell is asked for `@prompt $H` — a lone backspace — so that a
 * user who turns echo back on does not get `C:\dir>` threaded through every line.
 * A backspace moves a cursor in a real terminal and is invisible junk in a plain
 * text log, where it travels silently with anything the user copies out. Tabs and
 * newlines are content and must survive. */
test("control characters meant for a cursor do not reach a plain text log", { skip }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "nexotao-terminal-")));
  const session = new TerminalSession("root", dir);
  const sink = collector(session);
  try {
    session.run("printf 'a\\bb\\x0cc\\td\\n'");
    assert.ok(await sink.until(() => sink.text().includes("d")), "the output arrived");
    assert.ok(!/[\x00-\x08\x0b\x0c]/.test(sink.text()), "no cursor-control junk survived");
    assert.match(sink.text(), /abc\td/, "and the tab, which is content, did");
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
