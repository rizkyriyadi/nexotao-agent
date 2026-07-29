"use client";

/* `@` in the composer opens a file picker over the real workspace tree.
   Typing a path from memory is how you get a prompt that names a file which
   doesn't exist — and an agent that then goes looking for it. */

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";

/** Where an `@` mention starts in the text, or null when the caret isn't in one.
 *
 *  A mention only begins at a word boundary — otherwise an email address or a
 *  decorator (`user@host`, `@Component`) would pop the picker mid-typing. It
 *  ends at whitespace, because a path with a space in it can't be told apart
 *  from a mention followed by prose. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const preceding = at > 0 ? before[at - 1] : " ";
  if (!/\s/.test(preceding)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Rank paths against a query: a hit on the file name beats one on a directory
 *  in the middle of the path, and a shorter path beats a longer one. Someone
 *  typing `route` wants `app/api/files/route.ts`, not the deepest file that
 *  happens to sit under a folder with `route` in its name.
 *
 *  Naming the file outright is the strongest signal there is, so `route` puts
 *  `route.ts` above `router.ts` — otherwise the shorter-path tiebreak hands the
 *  top row to a file the user did not type the name of. */
export function rankPaths(paths: string[], query: string, limit = 12): string[] {
  const needle = query.toLowerCase();
  if (!needle) return paths.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const candidate of paths) {
    const lower = candidate.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const stem = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
    let score: number;
    if (name === needle || stem === needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (lower.includes(needle)) score = 3;
    else continue;
    scored.push({ path: candidate, score: score * 1000 + candidate.length });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.path);
}

export function MentionPicker({
  paths, query, onPick, onDismiss,
}: {
  paths: string[];
  query: string;
  onPick: (path: string) => void;
  onDismiss: () => void;
}) {
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => rankPaths(paths, query), [paths, query]);

  useEffect(() => { setIndex(0); }, [query]);

  // Arrow keys and Enter are captured here rather than in the textarea, so the
  // composer doesn't need to know a picker exists. Capture phase on `document`,
  // which runs before React's own listener on the root container.
  //
  // `stopPropagation` is what makes that work, and it is not belt-and-braces.
  // Choosing a file sets the composer's mention state to null, and React flushes
  // that synchronously for a discrete event like keydown — so the composer's
  // bubble-phase handler would then read the *new* props, see no mention open,
  // and send the prompt. The keystroke that picked a file would also submit it.
  // Ending the event here is the only way the guard downstream stays true.
  useEffect(() => {
    if (!matches.length) return;
    const onKey = (event: KeyboardEvent) => {
      const handled = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowDown") setIndex((i) => (i + 1) % matches.length);
      else if (event.key === "ArrowUp") setIndex((i) => (i - 1 + matches.length) % matches.length);
      else if (event.key === "Enter" || event.key === "Tab") onPick(matches[index]);
      else onDismiss();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [matches, index, onPick, onDismiss]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!matches.length) {
    return (
      <div className="absolute bottom-full left-0 z-40 mb-2 w-[340px] rounded-xl border border-line bg-paper-white p-3 shadow-float">
        <p className="text-[12px] text-pebble">No file matches “{query}”.</p>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention a file"
      className="scroll-thin absolute bottom-full left-0 z-40 mb-2 max-h-[280px] w-[380px] overflow-y-auto rounded-xl border border-line bg-paper-white p-1 shadow-float"
    >
      {matches.map((candidate, i) => {
        const cut = candidate.lastIndexOf("/");
        const folder = cut < 0 ? "" : candidate.slice(0, cut + 1);
        const name = candidate.slice(cut + 1);
        return (
          <button
            key={candidate}
            type="button"
            role="option"
            aria-selected={i === index}
            data-index={i}
            onMouseEnter={() => setIndex(i)}
            // The composer closes the picker on blur. Without this, clicking a
            // row blurs the textarea first and the picker is gone before the
            // click resolves — the row would look dead to the mouse.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(candidate)}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${i === index ? "bg-electric-indigo/[0.08]" : "hover:bg-veil"}`}
          >
            <FileText className="size-3.5 shrink-0 text-pebble" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">
              <span className="text-pebble">{folder}</span>
              <span className="font-medium text-charcoal">{name}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
