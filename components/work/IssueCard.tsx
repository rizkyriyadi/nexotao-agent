"use client";

/* One work item, as the board and the list draw it. Presentational only — it
   reports a click and a drag; who moves what is the surface's business. */

import { CalendarDays, GitBranch, Link2 } from "lucide-react";
import { LabelChip, PriorityDot, StatusTag, shortDate, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

export function IssueCard({ issue, data, onOpen, draggable = false, onDragStart, compact = false }: {
  issue: Issue;
  data: WorkData;
  onOpen: (issue: Issue) => void;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
  compact?: boolean;
}) {
  const labels = data.labels.filter((label) => issue.labelIds.includes(label.id));
  const assignee = data.agents.find((agent) => agent.id === issue.assigneeAgentId);
  const due = shortDate(issue.targetDate);

  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={() => onOpen(issue)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(issue); } }}
      className={`group cursor-pointer rounded-xl border border-line bg-raise/80 p-2.5 text-left transition-colors hover:border-line-strong focus:outline-none focus-visible:border-electric-indigo ${compact ? "" : "shadow-[0_1px_2px_rgba(0,0,0,0.03)]"}`}
    >
      <div className="flex items-start gap-2">
        <PriorityDot value={issue.priority} />
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-charcoal">{issue.title}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] text-pebble">{issue.ref}</span>
        <StatusTag status={issue.status} />
        {labels.map((label) => <LabelChip key={label.id} label={label} />)}
        {/* Relationships a card can carry that would otherwise only be visible
            after opening it — a sub-issue and a blocked card look identical
            without them. */}
        {issue.parentId && <GitBranch className="size-3 text-pebble" aria-label="Sub-issue" />}
        {issue.blockedBy.length > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-amber" title={`${issue.blockedBy.length} blocker(s)`}>
            <Link2 className="size-3" />{issue.blockedBy.length}
          </span>
        )}
        {issue.estimatePoint != null && (
          <span className="rounded bg-veil px-1 text-[10px] text-bark-grey" title="Estimate">{issue.estimatePoint}</span>
        )}
        {due && (
          <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-pebble"><CalendarDays className="size-3" />{due}</span>
        )}
        {assignee && (
          <span className="ml-auto rounded-full bg-electric-indigo/10 px-1.5 text-[10px] text-electric-indigo" title={assignee.name}>
            {assignee.name.slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>
    </article>
  );
}

export type { Issue };
