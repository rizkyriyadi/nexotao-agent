"use client";

/* A month grid keyed on `targetDate`. CSS grid, no calendar library.

   Work with no target date is listed under the grid rather than dropped: a
   calendar that silently hides two thirds of the backlog reads as an empty
   month, and the whole point of opening it is to find what is unscheduled. */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { IssueGroup } from "@/lib/work-view";
import { PriorityDot, useNow, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Local midnight, so a card lands on the day the user sees rather than the day
 *  UTC was on when the timestamp was written. */
const dayKey = (value: number) => { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

export function CalendarLayout({ groups, data, onOpen }: { groups: IssueGroup[]; data: WorkData; onOpen: (issue: Issue) => void }) {
  const [offset, setOffset] = useState(0);
  const now = useNow();
  const rows = useMemo(
    () => [...new Map(groups.flatMap((group) => group.issues).map((issue) => [issue.id, issue as Issue])).values()],
    [groups],
  );

  const { cells, title, undated } = useMemo(() => {
    const anchor = new Date(now ?? 0);
    anchor.setDate(1);
    anchor.setMonth(anchor.getMonth() + offset);
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    // Monday-first, matching the week anchoring the analytics use.
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);

    const byDay = new Map<string, Issue[]>();
    for (const issue of rows) {
      if (issue.targetDate == null) continue;
      const key = dayKey(issue.targetDate);
      byDay.set(key, [...(byDay.get(key) ?? []), issue]);
    }
    return {
      title: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      undated: rows.filter((issue) => issue.targetDate == null),
      cells: Array.from({ length: 42 }, (_, index) => {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
        return { date, inMonth: date.getMonth() === first.getMonth(), issues: byDay.get(dayKey(date.getTime())) ?? [] };
      }),
    };
  }, [rows, offset, now]);

  const today = now == null ? null : dayKey(now);
  // The grid is derived from the clock, so there is nothing meaningful to draw
  // until it has been read on the client.
  if (now == null) return <div className="min-h-0 flex-1 px-6 pb-6 text-xs text-pebble">Loading calendar…</div>;

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mb-3 flex items-center gap-2">
        <button aria-label="Previous month" onClick={() => setOffset(offset - 1)} className="rounded-lg border border-line p-1 text-pebble hover:text-charcoal"><ChevronLeft className="size-3.5" /></button>
        <h2 className="min-w-[150px] text-center text-[13px] font-semibold text-charcoal">{title}</h2>
        <button aria-label="Next month" onClick={() => setOffset(offset + 1)} className="rounded-lg border border-line p-1 text-pebble hover:text-charcoal"><ChevronRight className="size-3.5" /></button>
        {offset !== 0 && <button onClick={() => setOffset(0)} className="text-[11px] text-electric-indigo">Today</button>}
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-2xl border border-line bg-line">
        {WEEKDAYS.map((day) => <div key={day} className="bg-warm-bone px-2 py-1 text-[10px] font-medium text-pebble">{day}</div>)}
        {cells.map((cell, index) => (
          <div key={index} className={`min-h-[84px] bg-white/60 p-1.5 ${cell.inMonth ? "" : "opacity-40"}`}>
            <span className={`text-[10px] ${dayKey(cell.date.getTime()) === today ? "rounded bg-electric-indigo px-1 text-white" : "text-pebble"}`}>
              {cell.date.getDate()}
            </span>
            <div className="mt-1 space-y-0.5">
              {cell.issues.slice(0, 3).map((issue) => (
                <button key={issue.id} onClick={() => onOpen(issue)} className="flex w-full items-center gap-1 rounded border border-line bg-white px-1 py-0.5 text-left text-[10px] text-charcoal hover:border-line-strong">
                  <PriorityDot value={issue.priority} /><span className="truncate">{issue.title}</span>
                </button>
              ))}
              {cell.issues.length > 3 && <span className="pl-1 text-[10px] text-pebble">+{cell.issues.length - 3} more</span>}
            </div>
          </div>
        ))}
      </div>

      {undated.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-1.5 text-[11px] font-semibold text-pebble">No target date · {undated.length}</h3>
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
