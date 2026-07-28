"use client";

/* Charts drawn as inline SVG. No chart library: a bar chart is a list of rects
   and a burn-down is two polylines, and a dependency that ships a layout engine
   for that would weigh more than everything it draws.

   Every chart takes a viewBox in its own units and scales with CSS, so the same
   markup is legible in a narrow card and in a full-width panel. */

import type { ReactNode } from "react";

export function ChartCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white/60 p-4">
      <header className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-charcoal">{title}</h2>
        {hint && <span className="text-[11px] text-pebble">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white/60 p-4">
      <p className="text-[11px] text-pebble">{label}</p>
      <p className="mt-1 font-serif text-2xl text-charcoal">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-pebble">{hint}</p>}
    </div>
  );
}

/** A column chart. Bars are drawn from a shared maximum so two charts on the
 *  same page are only comparable when they say they are — each scales itself. */
export function BarChart({ data, height = 120 }: { data: Array<{ key: string; label: string; value: number }>; height?: number }) {
  if (!data.length) return <p className="py-6 text-center text-xs text-pebble">Nothing to chart yet.</p>;
  const max = Math.max(1, ...data.map((point) => point.value));
  const width = Math.max(data.length * 28, 120);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[120px] w-full" role="img" aria-label="Bar chart">
        {data.map((point, index) => {
          // A zero stays a hairline rather than nothing: an empty week is a
          // reading, and a gap in the axis reads as missing data instead.
          const bar = point.value === 0 ? 1 : Math.max(2, (point.value / max) * (height - 24));
          return (
            <g key={point.key}>
              <rect
                x={index * 28 + 6} y={height - 16 - bar} width={16} height={bar} rx={3}
                className={point.value === 0 ? "fill-line-strong" : "fill-electric-indigo/70"}
              >
                <title>{`${point.label}: ${point.value}`}</title>
              </rect>
              {point.value > 0 && (
                <text x={index * 28 + 14} y={height - 20 - bar} textAnchor="middle" className="fill-pebble text-[8px]">{point.value}</text>
              )}
            </g>
          );
        })}
        <line x1={0} y1={height - 16} x2={width} y2={height - 16} className="stroke-line" strokeWidth={1} />
      </svg>
      <div className="mt-1 flex" style={{ minWidth: 0 }}>
        {data.map((point) => (
          <span key={point.key} className="shrink-0 text-center text-[9px] text-pebble" style={{ width: `${100 / data.length}%` }}>
            {point.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A horizontal breakdown. Used where the categories are named rather than
 *  ordered — status, priority, assignee — because a name reads better beside its
 *  bar than under it. */
export function Breakdown({ data, total }: { data: Array<{ key: string; label?: string; count: number }>; total?: number }) {
  if (!data.length) return <p className="py-4 text-center text-xs text-pebble">No work items yet.</p>;
  // A zero denominator would render every bar as NaN%, so an empty breakdown
  // falls back to 1 — every bar is then honestly zero-width.
  const sum = (total ?? data.reduce((carry, row) => carry + row.count, 0)) || 1;
  return (
    <ul className="space-y-1.5">
      {data.map((row) => (
        <li key={row.key} className="flex items-center gap-2">
          {/* `capitalize` only touches the first letter of each word, so a name
              that is already cased — an agent's — is left as its owner wrote it. */}
          <span className="w-[92px] shrink-0 truncate text-[11.5px] capitalize text-bark-grey" title={row.label ?? row.key}>
            {(row.label ?? row.key).replace(/_/g, " ")}
          </span>
          <span className="h-2 min-w-[2px] flex-1 overflow-hidden rounded-full bg-black/[.05]">
            <span className="block h-full rounded-full bg-electric-indigo/60" style={{ width: `${(row.count / sum) * 100}%` }} />
          </span>
          <span className="w-6 shrink-0 text-right text-[11px] text-pebble">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** A burn-down: what remained each day against the straight line it would have
 *  followed if the work had drained evenly. The ideal is drawn from the first
 *  reading rather than from the cycle's nominal size — a cycle that grew mid
 *  sprint should show the climb, not a line that pretends it did not happen. */
export function Burndown({ points }: { points: Array<{ day: number; total: number; pending: number }> }) {
  if (points.length < 2) {
    return <p className="py-6 text-center text-xs text-pebble">A burn-down needs at least two days of readings. Snapshots are recorded once a day while the app runs.</p>;
  }
  const width = 320, height = 120, pad = 8;
  const max = Math.max(1, ...points.map((point) => Math.max(point.total, point.pending)));
  const x = (index: number) => pad + (index / (points.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  const line = (values: number[]) => values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const ideal = points.map((_, index) => points[0].pending * (1 - index / (points.length - 1)));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[130px] w-full" role="img" aria-label="Burn-down chart">
      <polyline points={line(ideal)} fill="none" strokeDasharray="3 3" className="stroke-line-strong" strokeWidth={1.5} />
      <polyline points={line(points.map((point) => point.pending))} fill="none" className="stroke-electric-indigo" strokeWidth={2} />
      {points.map((point, index) => (
        <circle key={point.day} cx={x(index)} cy={y(point.pending)} r={2.5} className="fill-electric-indigo">
          <title>{`${new Date(point.day * 86_400_000).toLocaleDateString()}: ${point.pending} of ${point.total} remaining`}</title>
        </circle>
      ))}
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="stroke-line" strokeWidth={1} />
    </svg>
  );
}

/** A progress bar for a cycle or module. Completed work and cancelled work both
 *  leave the pending pool, so the bar reaches full when nothing is outstanding —
 *  not when everything was delivered. */
export function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[.06]">
        <span className="block h-full rounded-full bg-electric-indigo transition-[width]" style={{ width: `${percent}%` }} />
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-pebble">{completed}/{total}</span>
    </div>
  );
}
