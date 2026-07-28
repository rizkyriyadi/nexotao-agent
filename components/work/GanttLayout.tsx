"use client";

/* A timeline of `startDate → targetDate`, drawn as absolutely-positioned bars
   over a day grid. No chart library: the whole geometry is "what fraction of the
   window does this range cover", which is two divisions.

   Work with neither date has no bar to draw and is listed separately — the same
   reasoning as the calendar's undated section. A card with only one of the two
   still gets a bar: a single day at whichever end is known, so it is visible
   rather than silently excluded for a missing field. */

import { useMemo } from "react";
import type { IssueGroup } from "@/lib/work-view";
import { PriorityDot, PRIORITY_TONE, shortDate, useNow, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

/* Declared here rather than imported from `lib/work-analytics`: that module
   opens the database, and importing it from a client component would pull
   sql.js into the browser bundle for the sake of one constant. */
const DAY_MS = 86_400_000;
const floorDay = (value: number) => Math.floor(value / DAY_MS) * DAY_MS;

export function GanttLayout({ groups, data, onOpen }: { groups: IssueGroup[]; data: WorkData; onOpen: (issue: Issue) => void }) {
  const now = useNow();
  const rows = useMemo(
    () => [...new Map(groups.flatMap((group) => group.issues).map((issue) => [issue.id, issue as Issue])).values()],
    [groups],
  );

  const { scheduled, undated, from, days } = useMemo(() => {
    const withDates = rows
      .map((issue) => {
        const start = issue.startDate ?? issue.targetDate;
        const end = issue.targetDate ?? issue.startDate;
        return start == null || end == null ? null : { issue, start: floorDay(start), end: floorDay(Math.max(start, end)) };
      })
      .filter((row): row is { issue: Issue; start: number; end: number } => row !== null);

    if (!withDates.length) return { scheduled: [], undated: rows, from: floorDay(now ?? 0), days: 14 };
    // Padded a day either side so a bar at the edge does not touch the frame.
    const min = Math.min(...withDates.map((row) => row.start)) - DAY_MS;
    const max = Math.max(...withDates.map((row) => row.end)) + DAY_MS;
    return {
      scheduled: withDates.sort((a, b) => a.start - b.start),
      undated: rows.filter((issue) => issue.startDate == null && issue.targetDate == null),
      from: min,
      days: Math.max(1, Math.round((max - min) / DAY_MS) + 1),
    };
  }, [rows, now]);

  const percent = (value: number) => ((value - from) / (days * DAY_MS)) * 100;
  // Null before mount, so the "today" line is simply absent on the first paint
  // rather than drawn at the server's instant and then jumping.
  const today = now == null ? null : floorDay(now);

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto px-6 pb-6">
      {!scheduled.length && <p className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-xs text-pebble">No work has a start or target date yet.</p>}

      {scheduled.length > 0 && (
        <div className="min-w-[640px] rounded-2xl border border-line bg-white/50 p-3">
          <div className="relative mb-2 h-4 border-b border-line">
            {Array.from({ length: days }, (_, index) => from + index * DAY_MS)
              // One tick a week keeps the axis readable on a long timeline.
              .filter((day) => Math.round((day - from) / DAY_MS) % 7 === 0)
              .map((day) => (
                <span key={day} className="absolute top-0 text-[10px] text-pebble" style={{ left: `${percent(day)}%` }}>{shortDate(day)}</span>
              ))}
          </div>

          <div className="relative space-y-1">
            {today != null && today >= from && today <= from + days * DAY_MS && (
              <span aria-hidden className="absolute top-0 bottom-0 z-10 w-px bg-electric-indigo/40" style={{ left: `${percent(today)}%` }} />
            )}
            {scheduled.map(({ issue, start, end }) => (
              <div key={issue.id} className="relative h-7">
                <button
                  onClick={() => onOpen(issue)}
                  title={`${issue.ref} · ${shortDate(start)} → ${shortDate(end)}`}
                  className="absolute top-0.5 flex h-6 min-w-[18px] items-center gap-1 overflow-hidden rounded-md border border-line bg-white px-1.5 text-left text-[10.5px] text-charcoal hover:border-line-strong"
                  style={{ left: `${percent(start)}%`, width: `${Math.max(percent(end + DAY_MS) - percent(start), 1.5)}%` }}
                >
                  <span className={`size-1.5 shrink-0 rounded-full ${PRIORITY_TONE[issue.priority] ?? PRIORITY_TONE.none}`} />
                  <span className="truncate">{issue.title}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {undated.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-1.5 text-[11px] font-semibold text-pebble">Unscheduled · {undated.length}</h3>
          <div className="flex flex-wrap gap-1.5">
            {undated.map((issue) => (
              <button key={issue.id} onClick={() => onOpen(issue)} className="flex items-center gap-1.5 rounded-lg border border-line bg-white/70 px-2 py-1 text-[11px] text-charcoal hover:border-line-strong">
                <PriorityDot value={issue.priority} />{issue.title}
              </button>
            ))}
          </div>
        </section>
      )}
      <p className="sr-only">{data.issues.length} work items in this project</p>
    </div>
  );
}
