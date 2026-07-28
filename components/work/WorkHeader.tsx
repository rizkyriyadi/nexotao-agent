"use client";

/* Layout, grouping, ordering, filters, and the new-item box.

   Every control writes into one `ViewConfig`, which the surface turns into query
   parameters. The server rebuilds the view from those parameters with the same
   `buildView` the client would have called, so a reload lands on the same board
   and a saved view is just this object stored. */

import { useState } from "react";
import { CalendarDays, Columns3, GanttChartSquare, List, Plus, Search, Table2 } from "lucide-react";
import type { GroupBy, Layout, OrderBy, ViewConfig } from "@/lib/work-view";
import { Picker, type WorkData } from "./parts";

const LAYOUTS: Array<{ value: Layout; label: string; icon: typeof List }> = [
  { value: "board", label: "Board", icon: Columns3 },
  { value: "list", label: "List", icon: List },
  { value: "spreadsheet", label: "Spreadsheet", icon: Table2 },
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "gantt", label: "Timeline", icon: GanttChartSquare },
];

const GROUPS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: "state", label: "State" }, { value: "priority", label: "Priority" }, { value: "assignee", label: "Assignee" },
  { value: "label", label: "Label" }, { value: "cycle", label: "Cycle" }, { value: "module", label: "Module" }, { value: "none", label: "None" },
];

const ORDERS: ReadonlyArray<{ value: OrderBy; label: string }> = [
  { value: "manual", label: "Manual" }, { value: "priority", label: "Priority" }, { value: "updated", label: "Updated" },
  { value: "created", label: "Created" }, { value: "target_date", label: "Target date" },
];

export function WorkHeader({ config, total, data, onConfig, onCreate }: {
  config: ViewConfig;
  total: number;
  data: WorkData;
  onConfig: (patch: Partial<ViewConfig>) => void;
  onCreate: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const create = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setAdding(true);
    try { await onCreate(trimmed); setTitle(""); } finally { setAdding(false); }
  };

  return (
    <header className="shrink-0 px-6 pt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div>
          <p className="label text-electric-indigo">Work</p>
          <h1 className="mt-1 font-serif text-3xl text-charcoal">Work items</h1>
        </div>
        <span className="text-xs text-pebble">{total} shown · {data.issues.length} total</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-line bg-white/60 p-0.5">
          {LAYOUTS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              aria-label={label}
              aria-pressed={config.layout === value}
              title={label}
              onClick={() => onConfig({ layout: value })}
              className={`flex items-center gap-1 rounded-[10px] px-2 py-1 text-[11.5px] transition-colors ${
                config.layout === value ? "bg-electric-indigo text-white" : "text-pebble hover:text-charcoal"
              }`}
            >
              <Icon className="size-3.5" /><span className="hidden md:inline">{label}</span>
            </button>
          ))}
        </div>

        <Picker label="Group by" value={config.groupBy} options={GROUPS} onChange={(groupBy) => onConfig({ groupBy })} />
        <Picker label="Order by" value={config.orderBy} options={ORDERS} onChange={(orderBy) => onConfig({ orderBy })} />

        <label className="flex items-center gap-1.5 rounded-lg border border-line bg-white/70 px-2 py-1">
          <Search className="size-3.5 text-pebble" />
          <input
            aria-label="Search work items"
            placeholder="Search"
            value={config.filters.search ?? ""}
            onChange={(event) => onConfig({ filters: { ...config.filters, search: event.target.value } })}
            className="w-28 bg-transparent text-[11.5px] text-charcoal outline-none placeholder:text-pebble"
          />
        </label>

        <label className="flex items-center gap-1.5 rounded-lg border border-line bg-white/70 px-2 py-1">
          <Plus className="size-3.5 text-pebble" />
          <input
            aria-label="New work item"
            placeholder="Add a work item"
            value={title}
            disabled={adding}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void create(); }}
            className="w-40 bg-transparent text-[11.5px] text-charcoal outline-none placeholder:text-pebble"
          />
        </label>
      </div>

      {/* Priority is the one filter that earns permanent space — it is the
          question a board is opened to answer. The rest live in the pickers. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-pebble">Priority</span>
        {["urgent", "high", "medium", "low"].map((priority) => {
          const on = config.filters.priorities?.includes(priority) ?? false;
          return (
            <button
              key={priority}
              aria-pressed={on}
              onClick={() => {
                const current = config.filters.priorities ?? [];
                onConfig({ filters: { ...config.filters, priorities: on ? current.filter((value) => value !== priority) : [...current, priority] } });
              }}
              className={`rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors ${
                on ? "border-transparent bg-electric-indigo/10 text-electric-indigo" : "border-line text-pebble hover:text-charcoal"
              }`}
            >
              {priority}
            </button>
          );
        })}
        {(config.filters.priorities?.length || config.filters.search) && (
          <button onClick={() => onConfig({ filters: {} })} className="text-[11px] text-electric-indigo">Clear</button>
        )}
      </div>
    </header>
  );
}
