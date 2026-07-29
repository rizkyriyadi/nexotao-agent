"use client";

/* The properties side panel.

   Properties only — no transcript, no run controls, no message box. The
   conversation with the agent lives at /board/[id] and this panel links to it.
   Duplicating that UI here would mean two places that render a run and two
   places to keep in step with the executor. */

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ExternalLink, X } from "lucide-react";
import { PRIORITY_ORDER } from "@/lib/work-view";
import { LabelChip, StatusTag, type WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

/** A single property row. Every one writes through PATCH /api/work/issues, so
 *  the lifecycle guards apply to an edit made here exactly as to a drag. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-[84px] shrink-0 pt-1 text-[11px] text-pebble">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const selectClass = "w-full rounded-lg border border-line bg-raise/70 px-2 py-1 text-[12px] text-charcoal capitalize outline-none focus:border-line-strong";

export function IssuePeek({ issue, data, onClose, onPatch }: {
  issue: Issue;
  data: WorkData;
  onClose: () => void;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { await onPatch(body); } finally { setBusy(false); }
  };

  const labels = data.labels.filter((label) => issue.labelIds.includes(label.id));
  const blockers = data.issues.filter((candidate) => issue.blockedBy.includes(candidate.id));
  const children = data.issues.filter((candidate) => candidate.parentId === issue.id);
  const dateValue = (value: number | null) => (value == null ? "" : new Date(value).toISOString().slice(0, 10));

  return (
    <aside className="scroll-thin flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-line bg-raise/60">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-raise/90 px-3 py-2 backdrop-blur">
        <span className="font-mono text-[11px] text-pebble">{issue.ref}</span>
        <StatusTag status={issue.status} />
        <Link
          href={`/board/${issue.id}`}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-charcoal hover:border-line-strong"
        >
          <ExternalLink className="size-3" />Open conversation
        </Link>
        <button aria-label="Close" onClick={onClose} className="rounded-lg p-1 text-pebble hover:text-charcoal"><X className="size-4" /></button>
      </header>

      <div className={`px-3 py-3 ${busy ? "pointer-events-none opacity-60" : ""}`}>
        <h2 className="text-[14px] font-medium leading-snug text-charcoal">{issue.title}</h2>
        {issue.detail && <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-bark-grey">{issue.detail}</p>}

        <div className="mt-3 divide-y divide-line border-t border-line">
          <Row label="State">
            {/* The only column that can be chosen by hand. In Progress is in the
                list because hiding it would be a lie — the server refuses it and
                says why, which teaches the rule instead of concealing it. */}
            <select
              aria-label="State"
              className={selectClass}
              value={issue.stateId ?? ""}
              onChange={(event) => void patch({ stateId: event.target.value })}
            >
              {data.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
            </select>
          </Row>

          <Row label="Priority">
            <select aria-label="Priority" className={selectClass} value={issue.priority} onChange={(event) => void patch({ priority: event.target.value })}>
              {PRIORITY_ORDER.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
            </select>
          </Row>

          <Row label="Assignee">
            <select
              aria-label="Assignee"
              className={selectClass}
              value={issue.assigneeAgentId ?? ""}
              onChange={(event) => void patch({ assigneeAgentId: event.target.value || null })}
            >
              <option value="">Unassigned</option>
              {data.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </Row>

          <Row label="Labels">
            <div className="flex flex-wrap gap-1">
              {data.labels.map((label) => {
                const on = issue.labelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    aria-pressed={on}
                    onClick={() => void patch({ labelIds: on ? issue.labelIds.filter((id) => id !== label.id) : [...issue.labelIds, label.id] })}
                    className={`rounded-full border px-1.5 py-px text-[10px] transition-colors ${on ? "border-transparent bg-electric-indigo/10 text-electric-indigo" : "border-line text-pebble"}`}
                  >
                    {label.name}
                  </button>
                );
              })}
              {!data.labels.length && <span className="text-[11px] text-pebble">No labels defined yet.</span>}
            </div>
          </Row>

          <Row label="Estimate">
            <input
              aria-label="Estimate"
              type="number"
              min={0}
              defaultValue={issue.estimatePoint ?? ""}
              onBlur={(event) => void patch({ estimatePoint: event.target.value === "" ? null : Number(event.target.value) })}
              className={selectClass}
            />
          </Row>

          <Row label="Cycle">
            <select aria-label="Cycle" className={selectClass} value={issue.cycleId ?? ""} onChange={(event) => void patch({ cycleId: event.target.value || null })}>
              <option value="">No cycle</option>
              {data.cycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
            </select>
          </Row>

          <Row label="Modules">
            <div className="flex flex-wrap gap-1">
              {data.modules.map((module) => {
                const on = issue.moduleIds.includes(module.id);
                return (
                  <button
                    key={module.id}
                    aria-pressed={on}
                    onClick={() => void patch({ moduleIds: on ? issue.moduleIds.filter((id) => id !== module.id) : [...issue.moduleIds, module.id] })}
                    className={`rounded-full border px-1.5 py-px text-[10px] transition-colors ${on ? "border-transparent bg-electric-indigo/10 text-electric-indigo" : "border-line text-pebble"}`}
                  >
                    {module.name}
                  </button>
                );
              })}
              {!data.modules.length && <span className="text-[11px] text-pebble">No modules defined yet.</span>}
            </div>
          </Row>

          <Row label="Start">
            {/* Read back as UTC midnight so the value the user picked is the day
                stored, not the day their offset happened to land on. */}
            <input
              aria-label="Start date" type="date" defaultValue={dateValue(issue.startDate)} className={selectClass}
              onChange={(event) => void patch({ startDate: event.target.value ? Date.parse(`${event.target.value}T00:00:00Z`) : null })}
            />
          </Row>
          <Row label="Target">
            <input
              aria-label="Target date" type="date" defaultValue={dateValue(issue.targetDate)} className={selectClass}
              onChange={(event) => void patch({ targetDate: event.target.value ? Date.parse(`${event.target.value}T00:00:00Z`) : null })}
            />
          </Row>

          {(blockers.length > 0 || children.length > 0 || labels.length > 0) && (
            <div className="py-2 text-[11.5px]">
              {labels.length > 0 && <div className="mb-2 flex flex-wrap gap-1">{labels.map((label) => <LabelChip key={label.id} label={label} />)}</div>}
              {blockers.length > 0 && (
                <div className="mb-1.5">
                  <p className="mb-1 text-[11px] text-pebble">Blocked by</p>
                  {blockers.map((blocker) => (
                    <p key={blocker.id} className="truncate text-charcoal"><span className="font-mono text-[10px] text-pebble">{blocker.ref}</span> {blocker.title}</p>
                  ))}
                </div>
              )}
              {children.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] text-pebble">Sub-issues</p>
                  {children.map((child) => (
                    <p key={child.id} className="truncate text-charcoal"><span className="font-mono text-[10px] text-pebble">{child.ref}</span> {child.title}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => { void navigator.clipboard?.writeText(issue.ref); toast.success(`Copied ${issue.ref}`); }}
          className="mt-3 text-[11px] text-pebble hover:text-charcoal"
        >
          Copy reference
        </button>
      </div>
    </aside>
  );
}
