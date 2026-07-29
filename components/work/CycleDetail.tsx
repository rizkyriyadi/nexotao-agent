"use client";

/* One cycle: its work items, how much is left, and the burn-down recorded by the
   daily snapshots. The curve is the only thing here that cannot be recomputed
   from the issues alone — "how much was outstanding last Tuesday" is a reading,
   not a derivation. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Burndown, ChartCard, ProgressBar, Stat } from "./charts";
import { PriorityDot, StatusTag, shortDate } from "./parts";
import type { Cycle } from "@/lib/work-model";
import type { Issue } from "@/lib/issues";

type Payload = {
  cycle: Cycle;
  issues: Issue[];
  progress: { total: number; completed: number; pending: number; points: number; completedPoints: number };
  burndown: Array<{ day: number; total: number; completed: number; pending: number }>;
};

export function CycleDetail({ id }: { id: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/work/cycles/${id}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Could not load that cycle"); return; }
    setData(body);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const complete = async () => {
    const response = await fetch("/api/work/cycles", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, completedAt: Date.now() }),
    });
    if (!response.ok) { toast.error("Could not close that cycle"); return; }
    toast.success("Cycle closed");
    await load();
  };

  if (error) return <p className="rounded-2xl border border-line bg-raise/60 p-8 text-center text-sm text-pebble">{error}</p>;
  if (!data) return <p className="text-sm text-pebble">Loading cycle…</p>;

  const { cycle, issues, progress, burndown } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/work/cycles" className="text-[12px] text-electric-indigo">← All cycles</Link>
        <h2 className="font-serif text-xl text-charcoal">{cycle.name}</h2>
        <span className="text-[11.5px] text-pebble">{shortDate(cycle.startDate) ?? "—"} → {shortDate(cycle.endDate) ?? "—"}</span>
        {!cycle.completedAt && (
          <button onClick={() => void complete()} className="ml-auto rounded-lg border border-line px-2.5 py-1 text-[12px] text-charcoal hover:border-line-strong">
            Close cycle
          </button>
        )}
        {cycle.completedAt && <span className="ml-auto rounded bg-veil px-1.5 py-px text-[10px] text-pebble">closed {shortDate(cycle.completedAt)}</span>}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label="Work items" value={String(progress.total)} hint={`${progress.pending} outstanding`} />
        <Stat label="Completed" value={String(progress.completed)} hint={progress.total ? `${Math.round((progress.completed / progress.total) * 100)}% of the cycle` : undefined} />
        <Stat label="Points" value={`${progress.completedPoints}/${progress.points}`} hint="estimated, completed of total" />
      </div>

      <ChartCard title="Burn-down" hint="outstanding work per day against an even burn">
        <Burndown points={burndown} />
      </ChartCard>

      <section className="rounded-2xl border border-line bg-raise/60 p-4">
        <header className="mb-3 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-charcoal">Work in this cycle</h2>
          <span className="min-w-[120px] flex-1"><ProgressBar completed={progress.completed} total={progress.total} /></span>
        </header>
        {!issues.length && <p className="py-6 text-center text-xs text-pebble">Nothing has been pulled into this cycle yet. Assign work to it from the item panel on the board.</p>}
        <ul className="divide-y divide-line">
          {issues.map((issue) => (
            <li key={issue.id} className="flex items-center gap-2 py-2">
              <PriorityDot value={issue.priority} />
              <Link href={`/board/${issue.id}`} className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal hover:text-electric-indigo">{issue.title}</Link>
              <StatusTag status={issue.status} />
              <span className="font-mono text-[10px] text-pebble">{issue.ref}</span>
              {issue.estimatePoint != null && <span className="rounded bg-veil px-1 text-[10px] text-bark-grey">{issue.estimatePoint}</span>}
              <span className="w-14 shrink-0 text-right text-[10.5px] capitalize text-pebble">{issue.status.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
