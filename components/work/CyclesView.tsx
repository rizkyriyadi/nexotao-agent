"use client";

/* Cycles: the time-boxed containers work moves through. A cycle is a date range
   with a name — the progress bar and the burn-down are read from the issues that
   point at it, so a cycle never holds state that could disagree with the board. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ProgressBar } from "./charts";
import { shortDate } from "./parts";
import type { Cycle } from "@/lib/work-model";

type Row = Cycle & { progress: { total: number; completed: number; pending: number; points: number; completedPoints: number } };

/** A date input yields `YYYY-MM-DD`; read it back at UTC midnight so the day the
 *  user picked is the day stored, whatever their offset. */
const parseDay = (value: string) => (value ? Date.parse(`${value}T00:00:00Z`) : null);

/** Where a cycle sits relative to now. Derived rather than stored: a cycle whose
 *  end date passed is over whether or not anything marked it so. */
function phase(cycle: Cycle, now: number | null): { word: string; tone: string } {
  if (cycle.completedAt) return { word: "completed", tone: "bg-veil text-pebble" };
  if (now == null) return { word: "", tone: "" };
  if (cycle.startDate && now < cycle.startDate) return { word: "upcoming", tone: "bg-electric-indigo/10 text-electric-indigo" };
  if (cycle.endDate && now > cycle.endDate) return { word: "overdue", tone: "bg-amber/12 text-amber" };
  return { word: "active", tone: "bg-lichen-green/12 text-lichen-green" };
}

export function CyclesView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: "", startDate: "", endDate: "" });
  useEffect(() => { setNow(Date.now()); }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/work/cycles", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setRows(body.cycles);
    else toast.error(body.error ?? "Could not load cycles");
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!draft.name.trim()) return;
    const response = await fetch("/api/work/cycles", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draft.name.trim(), startDate: parseDay(draft.startDate), endDate: parseDay(draft.endDate) }),
    });
    const body = await response.json();
    if (!response.ok) { toast.error(body.error ?? "Could not create that cycle"); return; }
    toast.success(`${body.cycle.name} created`);
    setDraft({ name: "", startDate: "", endDate: "" });
    await load();
  };

  if (loading) return <p className="text-sm text-pebble">Loading cycles…</p>;

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => { event.preventDefault(); void create(); }}
        className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-raise/60 p-3"
      >
        <label className="flex flex-col gap-1 text-[11px] text-pebble">
          Name
          <input
            value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="Sprint 4" aria-label="Cycle name"
            className="w-48 rounded-lg border border-line bg-raise px-2 py-1 text-[12.5px] text-charcoal outline-none focus:border-line-strong"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-pebble">
          Starts
          <input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
            aria-label="Cycle start date"
            className="rounded-lg border border-line bg-raise px-2 py-1 text-[12.5px] text-charcoal outline-none focus:border-line-strong" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-pebble">
          Ends
          <input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
            aria-label="Cycle end date"
            className="rounded-lg border border-line bg-raise px-2 py-1 text-[12.5px] text-charcoal outline-none focus:border-line-strong" />
        </label>
        <button type="submit" disabled={!draft.name.trim()}
          className="rounded-lg bg-electric-indigo px-3 py-1.5 text-[12px] text-on-indigo disabled:opacity-40">
          Add cycle
        </button>
      </form>

      {!rows.length && <p className="rounded-xl border border-dashed border-line px-3 py-10 text-center text-xs text-pebble">No cycles yet. A cycle is a date range work can be pulled into.</p>}

      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((cycle) => {
          const state = phase(cycle, now);
          return (
            <li key={cycle.id}>
              <Link href={`/work/cycles/${cycle.id}`} className="block rounded-2xl border border-line bg-raise/60 p-3.5 transition-colors hover:border-line-strong">
                <div className="flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-charcoal">{cycle.name}</h2>
                  {state.word && <span className={`rounded px-1.5 py-px text-[10px] font-medium ${state.tone}`}>{state.word}</span>}
                </div>
                <p className="mt-0.5 text-[11px] text-pebble">
                  {cycle.startDate || cycle.endDate ? `${shortDate(cycle.startDate) ?? "—"} → ${shortDate(cycle.endDate) ?? "—"}` : "No dates set"}
                  {cycle.progress.points > 0 && ` · ${cycle.progress.completedPoints}/${cycle.progress.points} points`}
                </p>
                <div className="mt-2.5"><ProgressBar completed={cycle.progress.completed} total={cycle.progress.total} /></div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
