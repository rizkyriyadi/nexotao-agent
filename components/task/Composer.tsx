"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronUp, CircleHelp, Cpu, List, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { useModels } from "./use-models";

export type RunMode = "agent" | "plan" | "ask";

type ModeSpec = { id: RunMode; label: string; icon: typeof Sparkles; blurb: string; desc: string };

// The three run modes the lead can take on a prompt. `blurb` is the one-liner
// shown next to the label; `desc` is the fuller description surfaced on hover.
// Keep in step with the menu's own max-height below: the flip decision is only
// correct if it measures against the height the menu will actually take.
const MODEL_MENU_MAX_H = 320;

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
  model,
  onModelChange,
  disabled,
  autoFocus,
  placeholder = "Ask, plan, or build anything in this project…",
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (mode: RunMode) => void;
  mode: RunMode;
  onModeChange: (m: RunMode) => void;
  /** The model this conversation runs on. Null means "whatever the project is
   *  configured for" — the picker shows that as Default. */
  model?: string | null;
  onModelChange?: (id: string | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Optional low-emphasis note folded into the bottom bar, right of the mode
   *  selector — keeps helper copy inside the card instead of floating below. */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelUp, setModelUp] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const models = useModels();
  const active = RUN_MODES.find((m) => m.id === mode) ?? RUN_MODES[0];
  const ActiveIcon = active.icon;
  const activeModel = models.find((m) => m.id === model) ?? null;

  // close the mode menu on outside click / escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => { if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setModelOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [modelOpen]);

  // The model list is tall, and the composer is near the *top* of the page on
  // the control panel — opening upward there ran the menu off the screen and cut
  // off the first entries, "Default model" among them. Measure on open and drop
  // downward when there isn't room above.
  useEffect(() => {
    if (!modelOpen) return;
    const anchor = modelRef.current?.getBoundingClientRect();
    setModelUp(!anchor || anchor.top > MODEL_MENU_MAX_H + 16);
  }, [modelOpen]);

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

        {/* model selector — hidden entirely when the catalog is unreachable, so
            an offline gateway leaves the composer usable on the default model */}
        {onModelChange && models.length > 0 && (
          <div className="relative" ref={modelRef}>
            <button
              type="button"
              onClick={() => setModelOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={modelOpen}
              title={activeModel ? `Running on ${activeModel.name}` : "Using this project's default model"}
              className="flex items-center gap-1.5 rounded-xl border border-line px-2.5 py-1.5 text-[13px] font-medium text-charcoal transition-colors hover:border-line-strong hover:bg-black/[0.02]"
            >
              <Cpu className="size-3.5 text-electric-indigo" />
              <span className="max-w-[9rem] truncate">{activeModel?.name ?? "Default model"}</span>
              <ChevronUp className={`size-3.5 text-pebble transition-transform ${modelOpen && modelUp ? "" : "rotate-180"}`} />
            </button>

            {modelOpen && (
              <div
                role="menu"
                className={`scroll-thin absolute left-0 z-30 max-h-[320px] w-[300px] overflow-y-auto rounded-xl border border-line bg-paper-white p-1 shadow-float ${modelUp ? "bottom-full mb-2" : "top-full mt-2"}`}
              >
                <ModelRow
                  label="Default model"
                  detail="Whatever this project is configured with"
                  on={!model}
                  onSelect={() => { onModelChange(null); setModelOpen(false); }}
                />
                {models.map((m) => (
                  <ModelRow
                    key={m.id}
                    label={m.name}
                    detail={`${m.id}${m.ctx ? ` · ${Math.round(m.ctx / 1000)}k context` : ""}`}
                    on={m.id === model}
                    onSelect={() => { onModelChange(m.id); setModelOpen(false); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {hint && (
          <span className="hidden min-w-0 flex-1 truncate text-[11.5px] text-pebble sm:block" aria-live="polite">
            {hint}
          </span>
        )}

        <Button size="icon" className="ml-auto size-9 rounded-xl" disabled={!value.trim() || disabled} onClick={submit} aria-label={`Send in ${active.label} mode`}>
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ModelRow({ label, detail, on, onSelect }: { label: string; detail: string; on: boolean; onSelect: () => void }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={on}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${on ? "bg-electric-indigo/[0.06]" : "hover:bg-black/[0.03]"}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-charcoal">{label}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-pebble">{detail}</span>
      </span>
      {on && <Check className="size-3.5 shrink-0 text-electric-indigo" />}
    </button>
  );
}
