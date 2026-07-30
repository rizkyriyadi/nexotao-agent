import test from "node:test";
import assert from "node:assert/strict";
import { isClearCommand, promptLabel, rememberCommand } from "../components/files/terminal-input";

/* `clear` is the command a user reaches for when the log is a wall of text, and
 * in this panel it did nothing at all: it asks the *terminal* to wipe its
 * screen, and we tell the shell the honest truth — `TERM=dumb`, because there
 * is no tty here. A dumb terminal has no clear capability, so `clear` exits 1
 * having printed nothing. The report from the field was the word typed twice in
 * a row, each answered by a bare `exit 1`. The screen this shell has is the log
 * in the panel, so the clear has to happen there. */
test("clear is handled by the panel, which is where this shell's screen is", () => {
  assert.ok(isClearCommand("clear"));
  assert.ok(isClearCommand("cls"), "the Windows spelling, since the shell may be cmd.exe");
  assert.ok(isClearCommand("  clear  "), "however it was typed");
  assert.ok(isClearCommand("CLEAR"));
});

/* But only the bare word. `clear && npm test` is a compound command the shell
 * owns, and swallowing it would silently drop the half the user actually cares
 * about — and `clearcache` merely starts with the letters. */
test("a command that merely contains clear still goes to the shell", () => {
  for (const command of ["clear && npm test", "clearcache", "git clear", "clear-cache", "clear; ls"]) {
    assert.equal(isClearCommand(command), false, command);
  }
});

/* Why: without dedup, the `npm test` a user ran nine times is nine presses of
 * Up before Arrow-Up reaches anything else — which makes history slower to use
 * than retyping, so it does not get used. */
test("history keeps one entry per command, most recent first", () => {
  let history: string[] = [];
  history = rememberCommand(history, "npm test");
  history = rememberCommand(history, "ls");
  history = rememberCommand(history, "npm test");
  assert.deepEqual(history, ["npm test", "ls"]);
});

test("history is bounded, so a long session cannot grow without limit", () => {
  let history: string[] = [];
  for (let i = 0; i < 150; i += 1) history = rememberCommand(history, `command ${i}`);
  assert.equal(history.length, 100);
  assert.equal(history[0], "command 149", "and it is the oldest that is dropped");
});

/* The prompt now sits inline on the last line of the log, where it shares the
 * line with what the user is typing. An absolute path is most of that line in a
 * dock this narrow — the screenshot that prompted this showed
 * `/Users/rizkyriyadi/Desktop/development/yamdimologi/yamdimologi-landing$`
 * with barely room for a command beside it. `~` is what bash, zsh and fish all
 * render, so it is the spelling a user reads without parsing. */
test("a path under home is shortened the way every shell shortens it", () => {
  assert.equal(promptLabel("/Users/riz/dev/app", "/Users/riz"), "~/dev/app");
  assert.equal(promptLabel("/Users/riz", "/Users/riz"), "~", "home itself is just ~");
  assert.equal(promptLabel("/var/log", "/Users/riz"), "/var/log", "and anything outside stays whole");
});

/* Why this is not a plain `startsWith`: `/Users/riz` is a prefix of the *string*
 * `/Users/rizky/app`, so the naive version renders `~ky/app` — a prompt naming
 * a folder that does not exist, on a machine where the user has no idea which
 * of the two accounts they are in. The boundary has to be a path separator. */
test("a home that is only a string prefix of the path does not shorten it", () => {
  assert.equal(promptLabel("/Users/rizky/app", "/Users/riz"), "/Users/rizky/app");
});

test("a missing home or cwd still yields something printable", () => {
  assert.equal(promptLabel("", "/Users/riz"), "~", "before the first cwd arrives");
  assert.equal(promptLabel("/var/log", ""), "/var/log", "and if the server never sent one");
  assert.equal(promptLabel("/Users/riz/", "/Users/riz/"), "~", "a home with a trailing slash");
});
