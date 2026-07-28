"use client";

/* One module: who leads it, what is left in it, and the work itself. No
   burn-down here — a module has no end date to burn towards, so a share of the
   whole is the only honest reading of "how far along". */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Breakdown, ChartCard, ProgressBar, Stat } from "./charts";
import { PriorityDot, StatusTag, shortDate } from "./parts";
import type { Module } from "@/lib/work-model";
import type { Issue } from "@/lib/issues";

type Payload = {
  module: Module;
  issues: Issue[];
  progress: { total: number; completed: number; pending: number; points: number; completedPoints: number };
};

export function ModuleDetail({ id }: { id: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/work/modules/${id}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Could not load that module"); return; }
    setData(body);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const complete = async () => {
    const response = await fetch("/api/work/modules", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, completedAt: Date.now() }),
    });
    if (!response.ok) { toast.error("Could not close that module"); return; }
    toast.success("Module closed");
    await load();
  };

  if (error) return <p className="rounded-2xl border border-line bg-white/60 p-8 text-center text-sm text-pebble">{error}</p>;
  if (!data) return <p className="text-sm text-pebble">Loading module…</p>;

  const { module: record, issues, progress } = data;
  // The status split is counted here rather than fetched: the issues are already
  // in hand, and an aggregate computed twice is an aggregate that can disagree.
  const byStatus = Object.entries(
    issues.reduce<Record<string, number>>((carry, issue) => ({ ...carry, [issue.status]: (carry[issue.status] ?? 0) + 1 }), {}),
  ).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/work/modules" className="text-[12px] text-electric-indigo">← All modules</Link>
        <h2 className="font-serif text-xl text-charcoal">{record.name}</h2>
        {record.targetDate && <span className="text-[11.5px] text-pebble">due {shortDate(record.targetDate)}</span>}
        {!record.completedAt && (
          <button onClick={() => void complete()} className="ml-auto rounded-lg border border-line px-2.5 py-1 text-[12px] text-charcoal hover:border-line-strong">
            Close module
          </button>
        )}
        {record.completedAt && <span className="ml-auto rounded bg-black/[.05] px-1.5 py-px text-[10px] text-pebble">closed {shortDate(record.completedAt)}</span>}
      </div>

      {record.description && <p className="text-[12.5px] leading-relaxed text-bark-grey">{record.description}</p>}

      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label="Work items" value={String(progress.total)} hint={`${progress.pending} outstanding`} />
        <Stat label="Completed" value={String(progress.completed)} hint={progress.total ? `${Math.round((progress.completed / progress.total) * 100)}% of the module` : undefined} />
        <Stat label="Points" value={`${progress.completedPoints}/${progress.points}`} hint="estimated, completed of total" />
      </div>

      <ChartCard title="Where the work sits" hint="by status">
        <Breakdown data={byStatus} total={progress.total} />
      </ChartCard>

      <section className="rounded-2xl border border-line bg-white/60 p-4">
        <header className="mb-3 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-charcoal">Work in this module</h2>
          <span className="min-w-[120px] flex-1"><ProgressBar completed={progress.completed} total={progress.total} /></span>
        </header>
        {!issues.length && <p className="py-6 text-center text-xs text-pebble">Nothing belongs to this module yet. Assign work to it from the item panel on the board.</p>}
        <ul className="divide-y divide-line">
          {issues.map((issue) => (
            <li key={issue.id} className="flex items-center gap-2 py-2">
              <PriorityDot value={issue.priority} />
              <Link href={`/board/${issue.id}`} className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal hover:text-electric-indigo">{issue.title}</Link>
              <StatusTag status={issue.status} />
              <span className="font-mono text-[10px] text-pebble">{issue.ref}</span>
              {issue.estimatePoint != null && <span className="rounded bg-black/[.05] px-1 text-[10px] text-bark-grey">{issue.estimatePoint}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
