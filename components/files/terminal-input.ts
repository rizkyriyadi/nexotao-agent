/* The two decisions the terminal's input line makes that are worth testing on
 * their own — everything else in TerminalPane is DOM. */

/** `clear` is not a command that prints something; it is a request to the
 *  *terminal* to wipe its screen, normally delivered as an escape sequence the
 *  emulator interprets. There is no emulator here, and the shell knows it: we
 *  set `TERM=dumb` (honestly — we have no tty), and a dumb terminal has no
 *  clear capability, so `clear` exits 1 having printed nothing. The user sees a
 *  bare `exit 1` and types it again.
 *
 *  The screen this shell has is the log in the panel, so the clear happens
 *  where the screen actually lives: client-side, without troubling the shell.
 *  Only the bare word — `clear && npm test` still runs, because the user asked
 *  for a compound command and the shell owns that. */
export function isClearCommand(command: string) {
  return /^(clear|cls)$/i.test(command.trim());
}

/** Most recent first, no duplicates, bounded. Deduplicating matters more than
 *  it looks: without it, the `npm test` a user ran nine times is nine presses of
 *  Up before they reach anything else. */
export function rememberCommand(history: readonly string[], command: string, cap = 100) {
  return [command, ...history.filter((entry) => entry !== command)].slice(0, cap);
}

/** The folder as a prompt, shortened the way every shell shortens it.
 *
 *  An absolute path in a panel this narrow is most of the line —
 *  `/Users/someone/Desktop/development/thing/thing-landing$` leaves almost no
 *  room for the command beside it, and wraps. `~` is not decoration; it is how
 *  bash, zsh and fish all render the same path, so it is the spelling a user
 *  reads without having to parse. */
export function promptLabel(cwd: string, home?: string) {
  if (!cwd) return "~";
  if (!home) return cwd;
  // Only a *path segment* boundary counts. `/Users/riz` must not shorten
  // `/Users/rizky/app` to `~ky/app` — a prompt claiming a folder the user does
  // not have is worse than a long one that is true.
  if (cwd === home) return "~";
  const stem = home.endsWith("/") || home.endsWith("\\") ? home : `${home}/`;
  return cwd.startsWith(stem) ? `~/${cwd.slice(stem.length)}` : cwd;
}
