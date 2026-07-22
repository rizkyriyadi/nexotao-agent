"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronUp, CircleHelp, List, Sparkles } from "lucide-react";
import { Button } from "../ui/button";

export type RunMode = "agent" | "plan" | "ask";

type ModeSpec = { id: RunMode; label: string; icon: typeof Sparkles; blurb: string; desc: string };

// The three run modes the lead can take on a prompt. `blurb` is the one-liner
// shown next to the label; `desc` is the fuller description surfaced on hover.
export const RUN_MODES: ModeSpec[] = [
  { id: "agent", label: "Agent", icon: Sparkles, blurb: "Build it for me",
    desc: "The lead works autonomously — reads, writes files, and runs commands to complete the task, then commits the result." },
  { id: "plan", label: "Plan", icon: List, blurb: "Draft a plan first",
    desc: "The lead investigates read-only and writes a numbered implementation plan. Nothing is changed — re-run in Agent mode to build it." },
  { id: "ask", label: "Ask", icon: CircleHelp, blurb: "Just answer",
    desc: "The lead answers your question using read-only inspection of the project. No files are created, edited, or run." },
];

/** kokonutui-style prompt: an auto-growing textarea with a run-mode selector and
 *  send button on the bottom bar. The user prompts, picks a mode, and the lead
 *  takes it straight to work. */
export function Composer({
  value,
  onChange,
  onSubmit,
  mode,
  onModeChange,
  disabled,
  autoFocus,
  placeholder = "Ask, plan, or build anything in this project…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (mode: RunMode) => void;
  mode: RunMode;
  onModeChange: (m: RunMode) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = RUN_MODES.find((m) => m.id === mode) ?? RUN_MODES[0];
  const ActiveIcon = active.icon;

  // close the mode menu on outside click / escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const submit = () => { if (value.trim() && !disabled) onSubmit(mode); };

  return (
    <div className="rounded-2xl border border-line-strong bg-paper-white p-2 shadow-float focus-within:border-electric-indigo/60">
      <textarea
        rows={1}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder={placeholder}
        aria-label="Prompt the lead agent"
        className="scroll-thin max-h-56 min-h-[44px] w-full resize-none bg-transparent px-2.5 py-2 text-[15px] leading-relaxed text-charcoal outline-none placeholder:text-pebble"
        style={{ fieldSizing: "content" } as React.CSSProperties}
      />

      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        {/* run-mode selector */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            title={active.desc}
            className="flex items-center gap-2 rounded-xl border border-line px-2.5 py-1.5 text-[13px] font-medium text-charcoal transition-colors hover:border-line-strong hover:bg-black/[0.02]"
          >
            <ActiveIcon className="size-3.5 text-electric-indigo" />
            {active.label}
            <ChevronUp className={`size-3.5 text-pebble transition-transform ${open ? "" : "rotate-180"}`} />
          </button>

          {open && (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-30 mb-2 w-[320px] overflow-hidden rounded-xl border border-line bg-paper-white p-1 shadow-float"
            >
              {RUN_MODES.map((m) => {
                const Icon = m.icon;
                const on = m.id === mode;
                return (
                  <button
                    key={m.id}
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => { onModeChange(m.id); setOpen(false); }}
                    className={`group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${on ? "bg-electric-indigo/[0.06]" : "hover:bg-black/[0.03]"}`}
                  >
                    <Icon className={`mt-0.5 size-4 shrink-0 ${on ? "text-electric-indigo" : "text-bark-grey"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[13.5px] font-medium text-charcoal">{m.label}</span>
                        <span className="text-[12px] text-pebble">· {m.blurb}</span>
                        {on && <Check className="ml-auto size-3.5 text-electric-indigo" />}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-bark-grey">{m.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <Button size="icon" className="size-9 rounded-xl" disabled={!value.trim() || disabled} onClick={submit} aria-label={`Send in ${active.label} mode`}>
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
