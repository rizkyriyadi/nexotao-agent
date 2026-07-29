"use client";

/* Editing half of the reader. A textarea overlaid on nothing clever — no
   CodeMirror, no Monaco. Both weigh more than this entire app ships today, and
   the job here is "fix a typo in .env, adjust a config value, correct a line the
   agent got wrong", not to be an IDE. Tab inserts a tab, the gutter tracks the
   scroll, and Cmd/Ctrl-S saves. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

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
  const [caret, setCaret] = useState({ line: 1, column: 1 });

  const lineCount = useMemo(() => value.split("\n").length, [value]);

  // The gutter is a sibling, not part of the text, so that a copy takes the
  // source without the numbering. The cost is that it has to be scrolled by
  // hand to stay level with the lines it labels.
  const sync = () => { if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop; };

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
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-electric-indigo/35 bg-[#faf9f7]">
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
        <textarea
          ref={area}
          value={value}
          spellCheck={false}
          aria-label="File contents"
          onChange={(event) => onChange(event.target.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          className="scroll-thin min-h-0 flex-1 resize-none bg-transparent px-3 py-3 leading-[1.65] text-charcoal outline-none"
        />
      </div>
    </div>
  );
}
