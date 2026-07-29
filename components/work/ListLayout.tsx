"use client";

/* Grouped rows with collapsible headers. Same grouping the board uses — only
   the shape differs, so switching layout never changes which work is shown. */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { IssueGroup } from "@/lib/work-view";
import { IssueCard } from "./IssueCard";
import { Empty, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

export function ListLayout({ groups, data, onOpen }: { groups: IssueGroup[]; data: WorkData; onOpen: (issue: Issue) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mx-auto max-w-4xl space-y-4">
        {groups.map((group) => {
          const shut = collapsed[group.key];
          return (
            <section key={group.key}>
              <button
                onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !shut }))}
                aria-expanded={!shut}
                className="mb-1.5 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-veil"
              >
                <ChevronRight className={`size-3.5 text-pebble transition-transform ${shut ? "" : "rotate-90"}`} />
                {group.color && <span className="size-2 rounded-full" style={{ background: group.color }} />}
                <span className="text-[12.5px] font-semibold capitalize text-charcoal">{group.label}</span>
                <span className="rounded-full bg-veil px-1.5 text-[10px] text-pebble">{group.issues.length}</span>
              </button>
              {!shut && (
                <div className="space-y-1.5">
                  {group.issues.map((issue) => <IssueCard key={issue.id} issue={issue as Issue} data={data} onOpen={onOpen} compact />)}
                  {!group.issues.length && <Empty>No work here</Empty>}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
