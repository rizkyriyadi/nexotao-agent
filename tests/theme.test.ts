import test from "node:test";
import assert from "node:assert/strict";
import { nextTheme, themeScript, THEME_KEY, type Theme } from "../components/Theme";

/* Why: this is the bug the toggle actually shipped with. The app defaults to
   "system"; a fixed light → dark → system rotation sends the first press to
   "light", which on a light-resolving OS repaints nothing at all. The button
   looks broken, and the user's next move is to press it again or give up —
   neither of which is a theme control working. The invariant is one line: the
   first press changes what is on screen. */
test("the first press always changes the appearance, whatever the OS says", () => {
  // What the user sees, which is the only thing the assertion cares about — a
  // theme name is not an appearance until the "system" case is resolved.
  const looksDark = (theme: Theme, systemDark: boolean) =>
    theme === "dark" || (theme === "system" && systemDark);

  for (const systemDark of [true, false]) {
    const first = nextTheme("system", systemDark);
    assert.notEqual(
      looksDark(first, systemDark),
      looksDark("system", systemDark),
      `stepping out of "system" on a ${systemDark ? "dark" : "light"} OS must flip the appearance`,
    );
  }
});

/* Why: a cycle that cannot get back to where it started strands anyone who
   pressed it once out of curiosity — "follow my system" becomes unreachable
   without clearing site data. Three presses, back to the beginning, both ways
   round. */
test("three presses return to following the system", () => {
  for (const systemDark of [true, false]) {
    let theme = nextTheme("system", systemDark);
    theme = nextTheme(theme, systemDark);
    theme = nextTheme(theme, systemDark);
    assert.equal(theme, "system", `cycle did not close on a ${systemDark ? "dark" : "light"} OS`);
  }
});

/* Why: every theme has to be reachable, or the control silently withholds one.
   Two presses from the default must have visited both explicit themes. */
test("the cycle visits light and dark before returning", () => {
  for (const systemDark of [true, false]) {
    const first = nextTheme("system", systemDark);
    const second = nextTheme(first, systemDark);
    assert.deepEqual([first, second].sort(), ["dark", "light"]);
  }
});

/* Why: this script runs before React exists, from a string, inside <head>. A
   syntax error in it is silent — the page still renders, just always light, and
   the failure looks exactly like the theme feature never having been built. It
   also must not throw when localStorage is unavailable, which is a real Safari
   configuration and not a hypothetical. */
test("the pre-paint script parses and survives a hostile localStorage", () => {
  const calls: { cls: string; on: boolean }[] = [];
  const element = {
    classList: { toggle: (cls: string, on: boolean) => calls.push({ cls, on }) },
    style: { colorScheme: "" },
  };
  const run = (storage: unknown, prefersDark: boolean) =>
    new Function("localStorage", "document", "matchMedia", themeScript)(
      storage,
      { documentElement: element },
      () => ({ matches: prefersDark }),
    );

  run({ getItem: () => "dark" }, false);
  assert.deepEqual(calls.at(-1), { cls: "dark", on: true }, "an explicit dark preference wins over a light OS");

  run({ getItem: () => "light" }, true);
  assert.deepEqual(calls.at(-1), { cls: "dark", on: false }, "and an explicit light preference wins over a dark OS");

  run({ getItem: () => null }, true);
  assert.deepEqual(calls.at(-1), { cls: "dark", on: true }, "with no preference stored, the OS decides");

  const before = calls.length;
  assert.doesNotThrow(() => run({ getItem: () => { throw new Error("blocked"); } }, false));
  assert.equal(calls.length, before, "a blocked localStorage leaves the default theme rather than a blank page");
});

/* Why: the key is written by the React toggle and read by the pre-paint script,
   which is a hand-built string that no compiler checks against the other. If
   they ever drift the preference is written and never read back, and dark mode
   silently forgets itself on every reload. */
test("the script reads the same storage key the toggle writes", () => {
  assert.ok(themeScript.includes(JSON.stringify(THEME_KEY)));
});
