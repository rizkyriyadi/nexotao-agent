"use client";

/* Editing half of the reader. Still no CodeMirror and no Monaco — both weigh
   more than this entire app ships today, and the job here is "fix a typo in
   .env, adjust a config value, correct a line the agent got wrong", not to be
   an IDE. Tab inserts a tab, the gutter tracks the scroll, Cmd/Ctrl-S saves.

   Colour arrives without either of them: coloured text is painted *behind* a
   textarea whose own text is transparent, and the two are held in alignment by
   sharing every font and box property. That is the whole trick, and its one
   failure mode is worth stating — if the layers ever disagree about metrics,
   the caret drifts from the glyphs. Hence `whitespace-pre-wrap` and identical
   padding on both, and `lib/highlight.ts` guaranteeing its tokens rebuild the
   input exactly. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { isHighlightable } from "@/lib/highlight";
import { CodeText } from "./CodeText";

export function FileEditor({
  value, onChange, language, onSave, saving,
}: {
  value: string;
  onChange: (next: string) => void;
  language: string;
  onSave: () => void;
  saving: boolean;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1 });

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const coloured = isHighlightable(language, value);

  // The gutter is a sibling, not part of the text, so that a copy takes the
  // source without the numbering. The cost is that it has to be scrolled by
  // hand to stay level with the lines it labels — and the colour layer beneath
  // the textarea has to be scrolled with it, in both axes.
  const sync = () => {
    const source = area.current;
    if (!source) return;
    if (gutter.current) gutter.current.scrollTop = source.scrollTop;
    if (layer.current) {
      layer.current.scrollTop = source.scrollTop;
      layer.current.scrollLeft = source.scrollLeft;
    }
  };

  const trackCaret = () => {
    const element = area.current;
    if (!element) return;
    const before = element.value.slice(0, element.selectionStart);
    const lines = before.split("\n");
    setCaret({ line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 });
  };

  useEffect(() => { trackCaret(); }, [value]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
      return;
    }
    // Without this, Tab leaves the field — which in a code editor reads as the
    // editor being broken rather than as focus moving on.
    if (event.key === "Tab") {
      event.preventDefault();
      const element = event.currentTarget;
      const { selectionStart: start, selectionEnd: end } = element;
      const next = `${value.slice(0, start)}\t${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = start + 1; });
    }
  };

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-electric-indigo/35 bg-code-surface/60">
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-code-surface px-3 py-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-pebble">{language}</span>
        <span className="flex items-center gap-2 text-[10.5px] text-pebble">
          {saving && <Loader2 className="size-3 animate-spin" />}
          <span>Ln {caret.line}, Col {caret.column}</span>
          <span aria-hidden>·</span>
          <span>{lineCount} lines</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 font-mono text-[12.5px] leading-[1.65]">
        <div
          ref={gutter}
          aria-hidden
          className="hide-scrollbar shrink-0 select-none overflow-hidden border-r border-line px-2.5 py-3 text-right text-pebble/70"
        >
          {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        {/* The two layers below must agree on every property that affects where
            a glyph lands: font, size, line-height, padding, wrapping. They are
            spelled identically on purpose — a change to one is a bug unless it
            is made to both. */}
        <div className="relative min-h-0 flex-1">
          {coloured && (
            <pre
              ref={layer}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 leading-[1.65] text-charcoal"
            >
              <CodeText text={value} language={language} />
              {/* A trailing newline leaves the last line unrendered in a <pre>,
                  so the colour layer would come up one line short of the
                  textarea and every glyph after it would sit off by a row. */}
              {"\n"}
            </pre>
          )}
          <textarea
            ref={area}
            value={value}
            spellCheck={false}
            aria-label="File contents"
            onChange={(event) => { onChange(event.target.value); sync(); }}
            onScroll={sync}
            onKeyDown={onKeyDown}
            onKeyUp={trackCaret}
            onClick={trackCaret}
            className={`scroll-thin absolute inset-0 h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent px-3 py-3 leading-[1.65] outline-none ${
              // The text is still *there* — selection and the caret are drawn
              // from it. Only the glyphs are hidden, so the colour beneath shows
              // through. `caret-color` has to be restored explicitly, or the
              // caret goes transparent along with the text.
              coloured ? "text-transparent caret-charcoal selection:bg-electric-indigo/25" : "text-charcoal"
            }`}
          />
        </div>
      </div>
    </div>
  );
}
