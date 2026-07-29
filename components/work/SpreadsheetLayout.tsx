"use client";

/* Every property in one grid, with the columns the user does not care about
   switched off. Rows are flattened out of the groups rather than re-derived, so
   the filter and order the header set still apply — a spreadsheet that quietly
   showed everything would be a different answer to the same question. */

import { useState } from "react";
import type { IssueGroup } from "@/lib/work-view";
import { PriorityDot, StatusTag, shortDate, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

const COLUMNS = [
  { key: "priority", label: "Priority" }, { key: "status", label: "Status" }, { key: "assignee", label: "Assignee" },
  { key: "labels", label: "Labels" }, { key: "estimate", label: "Est." }, { key: "cycle", label: "Cycle" },
  { key: "module", label: "Module" }, { key: "start", label: "Start" }, { key: "target", label: "Target" },
] as const;
type ColumnKey = (typeof COLUMNS)[number]["key"];

export function SpreadsheetLayout({ groups, data, onOpen }: { groups: IssueGroup[]; data: WorkData; onOpen: (issue: Issue) => void }) {
  const [hidden, setHidden] = useState<Partial<Record<ColumnKey, boolean>>>({});
  const shown = COLUMNS.filter((column) => !hidden[column.key]);
  // An issue in two labels appears in two groups; the grid lists work items, so
  // de-duplicate before rendering.
  const rows = [...new Map(groups.flatMap((group) => group.issues).map((issue) => [issue.id, issue as Issue])).values()];
  const name = <T extends { id: string; name: string }>(list: T[], id: string | null) => list.find((row) => row.id === id)?.name ?? "—";

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto px-6 pb-6">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-pebble">Columns</span>
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            aria-pressed={!hidden[column.key]}
            onClick={() => setHidden((current) => ({ ...current, [column.key]: !current[column.key] }))}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
              hidden[column.key] ? "border-line text-pebble" : "border-electric-indigo/30 bg-electric-indigo/[.07] text-electric-indigo"
            }`}
          >
            {column.label}
          </button>
        ))}
      </div>

      <table className="w-full border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr className="text-left text-[11px] text-pebble">
            <th className="sticky top-0 z-10 border-b border-line bg-warm-bone px-2 py-1.5 font-medium">Work item</th>
            {shown.map((column) => <th key={column.key} className="sticky top-0 z-10 border-b border-line bg-warm-bone px-2 py-1.5 font-medium">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((issue) => (
            <tr key={issue.id} onClick={() => onOpen(issue)} className="cursor-pointer hover:bg-veil">
              <td className="border-b border-line px-2 py-1.5">
                <span className="mr-1.5 font-mono text-[10px] text-pebble">{issue.ref}</span>
                <span className="text-charcoal">{issue.title}</span>
              </td>
              {shown.map((column) => (
                <td key={column.key} className="whitespace-nowrap border-b border-line px-2 py-1.5 text-bark-grey">
                  {column.key === "priority" && <span className="inline-flex items-center gap-1.5 capitalize"><PriorityDot value={issue.priority} />{issue.priority}</span>}
                  {column.key === "status" && (<span className="capitalize">{issue.status.replace("_", " ")}<StatusTag status={issue.status} /></span>)}
                  {column.key === "assignee" && name(data.agents as Array<{ id: string; name: string }>, issue.assigneeAgentId)}
                  {column.key === "labels" && (data.labels.filter((label) => issue.labelIds.includes(label.id)).map((label) => label.name).join(", ") || "—")}
                  {column.key === "estimate" && (issue.estimatePoint ?? "—")}
                  {column.key === "cycle" && name(data.cycles, issue.cycleId)}
                  {column.key === "module" && (data.modules.filter((module) => issue.moduleIds.includes(module.id)).map((module) => module.name).join(", ") || "—")}
                  {column.key === "start" && (shortDate(issue.startDate) ?? "—")}
                  {column.key === "target" && (shortDate(issue.targetDate) ?? "—")}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={shown.length + 1} className="px-2 py-8 text-center text-xs text-pebble">Nothing matches these filters.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
