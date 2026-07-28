"use client";

/* Analytics. Four readings that answer different questions: how much is
   finishing (throughput), how long it takes (cycle time), where the open work
   sits (distributions), and whether a cycle is on course (burn-down).

   Everything here is derived server-side from the activity log and the daily
   snapshots. Nothing is stored as a metric, so a number on this page can never
   disagree with the board it was counted from. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { BarChart, Breakdown, Burndown, ChartCard, Stat } from "./charts";
import { shortDate } from "./parts";
import type { Cycle } from "@/lib/work-model";

type Analytics = {
  throughput: Array<{ week: number; completed: number }>;
  byStatus: Array<{ key: string; label: string; count: number }>;
  byPriority: Array<{ key: string; label: string; count: number }>;
  byAssignee: Array<{ key: string; label: string; count: number }>;
  open: number;
  completed: number;
  averageCycleTimeMs: number | null;
};

type Payload = {
  analytics: Analytics;
  cycles: Array<{
    cycle: Cycle;
    progress: { total: number; completed: number; pending: number; points: number; completedPoints: number };
    burndown: Array<{ day: number; total: number; completed: number; pending: number }>;
  }>;
};

/** Cycle time reads in days once it passes a day, and in hours below that.
 *  "0.3 days" is a number nobody converts in their head. */
function duration(ms: number | null): string {
  if (ms == null) return "—";
  const hours = ms / 3_600_000;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function AnalyticsView() {
  const [data, setData] = useState<Payload | null>(null);
  const [weeks, setWeeks] = useState(12);

  const load = useCallback(async () => {
    const response = await fetch(`/api/work/analytics?weeks=${weeks}`, { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setData(body); else toast.error(body.error ?? "Could not load analytics");
  }, [weeks]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return <p className="text-sm text-pebble">Loading analytics…</p>;
  const { analytics, cycles } = data;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Open" value={String(analytics.open)} hint="not yet completed" />
        <Stat label="Completed" value={String(analytics.completed)} hint="all time" />
        <Stat label="Average cycle time" value={duration(analytics.averageCycleTimeMs)} hint="first start to completion" />
        <Stat
          label="Throughput"
          value={String(analytics.throughput.reduce((carry, week) => carry + week.completed, 0))}
          hint={`over the last ${weeks} weeks`}
        />
      </div>

      <ChartCard title="Throughput" hint="work items completed per week">
        <div className="mb-2 flex items-center gap-1.5">
          {[6, 12, 26, 52].map((option) => (
            <button
              key={option} onClick={() => setWeeks(option)}
              className={`rounded-lg px-2 py-0.5 text-[11px] transition-colors ${
                option === weeks ? "bg-electric-indigo text-white" : "border border-line text-pebble hover:text-charcoal"
              }`}
            >
              {option}w
            </button>
          ))}
        </div>
        <BarChart
          data={analytics.throughput.map((week) => ({
            key: String(week.week),
            // Week columns are dense, so only the day-of-month is labelled —
            // the axis is a sequence of weeks, and the year never changes twice
            // inside one chart.
            label: new Date(week.week).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
            value: week.completed,
          }))}
        />
      </ChartCard>

      <div className="grid gap-2 lg:grid-cols-3">
        <ChartCard title="By status"><Breakdown data={analytics.byStatus} /></ChartCard>
        <ChartCard title="By priority"><Breakdown data={analytics.byPriority} /></ChartCard>
        <ChartCard title="By assignee"><Breakdown data={analytics.byAssignee} /></ChartCard>
      </div>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold text-charcoal">Cycle burn-down</h2>
        {!cycles.length && (
          <p className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-xs text-pebble">
            No cycles yet. A burn-down needs a cycle to burn down.
          </p>
        )}
        <div className="grid gap-2 lg:grid-cols-2">
          {cycles.map((entry) => (
            <ChartCard
              key={entry.cycle.id}
              title={entry.cycle.name}
              hint={`${entry.progress.completed}/${entry.progress.total} done · ${shortDate(entry.cycle.startDate) ?? "—"} → ${shortDate(entry.cycle.endDate) ?? "—"}`}
            >
              <Burndown points={entry.burndown} />
              <Link href={`/work/cycles/${entry.cycle.id}`} className="mt-2 inline-block text-[11.5px] text-electric-indigo">
                Open cycle →
              </Link>
            </ChartCard>
          ))}
        </div>
      </section>
    </div>
  );
}
