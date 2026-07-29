"use client";

/* The small pieces every layout draws: a priority marker, a label chip, an
   assignee, a date. Kept in one file because a card in the board, a row in the
   spreadsheet and a bar in the gantt must read as the same work item — five
   private copies of "how a label looks" is how they stop matching. */

import { useEffect, useState, type ReactNode } from "react";
import type { Cycle, Label, Module, WorkflowState } from "@/lib/work-model";
import type { Issue } from "@/lib/issues";

export type WorkData = {
  projectId: string;
  issues: Issue[];
  states: WorkflowState[];
  labels: Label[];
  cycles: Cycle[];
  modules: Module[];
  agents: Array<{ id: string; name: string }>;
};

export const PRIORITY_TONE: Record<string, string> = {
  urgent: "bg-alarm-red", high: "bg-amber", medium: "bg-amber", low: "bg-pebble", none: "bg-line-strong",
};

/** Statuses the board has no column for still need a word on the card: work in
 *  the Todo column may be `blocked`, and Done holds `cancelled` too. Without
 *  this the two would be invisible — which is exactly when they matter. */
export const OFF_COLUMN_STATUS: Record<string, string> = { blocked: "blocked", cancelled: "cancelled" };

export function PriorityDot({ value }: { value: string }) {
  return <span title={`Priority: ${value}`} className={`inline-block size-[7px] shrink-0 rounded-full ${PRIORITY_TONE[value] ?? PRIORITY_TONE.none}`} />;
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-px text-[10px] text-bark-grey">
      <span className="size-[6px] rounded-full" style={{ background: label.color }} />
      {label.name}
    </span>
  );
}

export function StatusTag({ status }: { status: string }) {
  const word = OFF_COLUMN_STATUS[status];
  if (!word) return null;
  const tone = word === "blocked" ? "bg-amber/12 text-amber" : "bg-veil text-pebble line-through";
  return <span className={`rounded px-1.5 py-px text-[10px] font-medium ${tone}`}>{word}</span>;
}

/** Dates render in the browser's zone but are stored as UTC epochs. Short form
 *  everywhere — a board column is not wide enough for a full date. */
export const shortDate = (value: number | null) =>
  value == null ? null : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The current time, read after mount rather than during render.
 *
 *  These pages are server-rendered, so reading the clock while rendering gives
 *  the server's instant and the browser's instant a chance to disagree — which
 *  is a hydration mismatch on any view that highlights "today". Null until
 *  mounted, so the marker simply is not drawn during the first paint. */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); }, []);
  return now;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-pebble">{children}</p>;
}

/** A labelled native select. Native rather than a Radix popover on purpose: the
 *  header carries five of these and a keyboard user should be able to tab
 *  through them without opening a dialog for each. */
export function Picker<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-pebble">
      <span className="hidden sm:inline">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="rounded-lg border border-line bg-raise/70 px-2 py-1 text-[11.5px] text-charcoal capitalize outline-none focus:border-line-strong"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
