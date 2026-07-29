"use client";

/* Light / dark / follow-the-system, stored locally.
 *
 * No `next-themes` — the whole mechanism is one class on <html>, and the only
 * genuinely hard part (not flashing white before React boots) has to be solved
 * with a blocking inline script either way. See `themeScript` below.
 */

import { useCallback, useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "nexotao.theme";

/** Runs before first paint, from `<head>`. React hydrating later would already
 *  be one paint too late — the user would see the light theme flash by on every
 *  navigation that reloads the document.
 *
 *  Wrapped in try/catch because `localStorage` throws outright in a locked-down
 *  Safari; the cost of that is the default theme, not a blank page. */
export const themeScript = `
(function () {
  try {
    var t = localStorage.getItem(${JSON.stringify(THEME_KEY)}) || "system";
    var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();
`;

function apply(theme: Theme) {
  const dark = theme === "dark"
    || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("system");
  const [systemDark, setSystemDark] = useState(false);
  // The script above has already set the class; this only catches React up to
  // what the DOM is doing, so the toggle shows the right state.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem(THEME_KEY) as Theme | null) ?? "system";
    setThemeState(stored);
    setSystemDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    setReady(true);
  }, []);

  // The OS can change out from under us — at sunset, or when someone flips the
  // setting in another window. Tracked whatever the current choice is, because
  // the toggle's next step depends on it even while pinned to an explicit theme.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
      if (theme === "system") apply("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    apply(next);
  }, []);

  return { theme, setTheme, ready, systemDark };
}

/** The next theme in the cycle.
 *
 *  Not a fixed light → dark → system rotation, and that is the whole point. The
 *  app starts on "system". Someone whose OS is light pressing a fixed cycle
 *  lands on "light" — the same pixels they were already looking at — and reads
 *  the button as broken. So the step out of "system" is always *away* from what
 *  the OS is currently giving you; the press after that pins the OS's own
 *  appearance, and the third returns to following it.
 *
 *  Light OS:  system → dark → light → system
 *  Dark OS:   system → light → dark → system
 *
 *  Both orders share the property that matters: the first press repaints. */
export function nextTheme(theme: Theme, systemDark: boolean): Theme {
  const away: Theme = systemDark ? "light" : "dark";
  const pinned: Theme = systemDark ? "dark" : "light";
  if (theme === "system") return away;
  if (theme === away) return pinned;
  return "system";
}

const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Match system" };
const ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

/** One button, no menu. A three-way control that opens a menu costs a click
 *  every time to reach the one thing anybody actually wants, which is the other
 *  theme. See `nextTheme` for why the order is not fixed. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme, ready, systemDark } = useTheme();
  const next = nextTheme(theme, systemDark);
  const Icon = ICON[theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABEL[theme]} — switch to ${LABEL[next].toLowerCase()}`}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next].toLowerCase()}.`}
      // Invisible until the stored preference is known, so the icon never shows
      // one theme and then swaps to the other a frame later.
      className={`flex size-9 items-center justify-center rounded-xl text-pebble transition-colors hover:bg-veil hover:text-charcoal ${ready ? "" : "opacity-0"} ${className}`}
    >
      <Icon className="size-[18px]" strokeWidth={1.8} />
    </button>
  );
}
