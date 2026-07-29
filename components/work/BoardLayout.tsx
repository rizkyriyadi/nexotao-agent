"use client";

/* Kanban. Drag-and-drop is the HTML5 native API — `draggable` plus
   dragstart/dragover/drop — deliberately, not a library: moving a card between
   two columns and dropping it at a position is the whole requirement, and a drag
   library would be a dependency the rest of the repo does not need.

   A drop asks the server, then re-reads. It does not move the card locally
   first: dropping into In Progress is refused by the lifecycle, and a board that
   showed the card there while the request failed would be showing work the
   engine never agreed to start. */

import { useState } from "react";
import { nextSequence, type IssueGroup } from "@/lib/work-view";
import { IssueCard } from "./IssueCard";
import { Empty, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

export type Drop = { issueId: string; groupKey: string; sequence: number | null };

export function BoardLayout({ groups, data, onOpen, onDrop, groupedByState }: {
  groups: IssueGroup[];
  data: WorkData;
  onOpen: (issue: Issue) => void;
  onDrop: (drop: Drop) => void;
  groupedByState: boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  /* Where in the column the card landed. The neighbours are read from the
     column as currently rendered, so the midpoint is between what the user saw,
     and the dragged card is excluded so re-dropping it in place is a no-op
     rather than a midpoint with itself. */
  const dropAt = (group: IssueGroup, index: number, issueId: string) => {
    const rest = group.issues.filter((issue) => issue.id !== issueId);
    const at = Math.min(index, rest.length);
    onDrop({ issueId, groupKey: group.key, sequence: nextSequence(rest[at - 1]?.sequence, rest[at]?.sequence) });
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="scroll-thin flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6">
      {groups.map((group) => (
        <section
          key={group.key}
          onDragOver={(event) => { event.preventDefault(); setOver(group.key); }}
          onDragLeave={() => setOver((current) => (current === group.key ? null : current))}
          onDrop={(event) => { event.preventDefault(); if (dragging) dropAt(group, group.issues.length, dragging); }}
          className={`flex w-[272px] shrink-0 flex-col rounded-2xl border p-2 transition-colors ${
            over === group.key ? "border-electric-indigo bg-electric-indigo/[.04]" : "border-line bg-raise/40"
          }`}
        >
          <header className="flex items-center gap-2 px-1.5 pb-2 pt-1">
            {group.color && <span className="size-2 rounded-full" style={{ background: group.color }} />}
            <h2 className="text-[12px] font-semibold capitalize text-charcoal">{group.label}</h2>
            <span className="rounded-full bg-veil px-1.5 text-[10px] text-pebble">{group.issues.length}</span>
          </header>

          <div className="scroll-thin flex min-h-[80px] flex-1 flex-col gap-1.5 overflow-y-auto">
            {group.issues.map((issue, index) => (
              <div
                key={issue.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.stopPropagation(); event.preventDefault(); if (dragging) dropAt(group, index, dragging); }}
              >
                <IssueCard
                  issue={issue as Issue}
                  data={data}
                  onOpen={onOpen}
                  // Reordering is only meaningful along an axis a drop can
                  // write. Grouping by label would make a drop ambiguous —
                  // an issue can carry several — so dragging is off there.
                  draggable={groupedByState}
                  onDragStart={(event) => { setDragging(issue.id); event.dataTransfer.effectAllowed = "move"; }}
                />
              </div>
            ))}
            {!group.issues.length && <Empty>Drop work here</Empty>}
          </div>
        </section>
      ))}
    </div>
  );
}
