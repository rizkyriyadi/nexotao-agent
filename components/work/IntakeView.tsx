"use client";

/* Triage. Work that arrived from outside the board waits here for a decision,
   so nothing an agent did not ask for passes through unreviewed.

   Accepting keeps the item at whatever status it already has: intake is a flag
   beside the status, not a state in front of it. Declining and Duplicate cancel
   the work outright, which the scheduler can see; snoozing only clears the row.

   Intake is off by default: an item only appears here if something marked it
   pending. An empty queue is therefore the normal state, not a broken one — the
   empty message says so rather than reading like a failure. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PriorityDot, StatusTag, shortDate } from "./parts";
import type { Issue } from "@/lib/issues";

const DECISIONS = [
  { key: "accept", label: "Accept", done: "accepted", hint: "keeps it, at the status it already has" },
  { key: "snooze", label: "Snooze", done: "snoozed", hint: "clears the queue without deciding" },
  { key: "duplicate", label: "Duplicate", done: "marked a duplicate", hint: "cancels it as already tracked" },
  { key: "decline", label: "Decline", done: "declined", hint: "cancels it" },
] as const;

type Decision = (typeof DECISIONS)[number];

export function IntakeView() {
  const [pending, setPending] = useState<Issue[]>([]);
  const [recent, setRecent] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/work/intake", { cache: "no-store" });
    const body = await response.json();
    if (response.ok) { setPending(body.pending); setRecent(body.recent); }
    else toast.error(body.error ?? "Could not load the intake queue");
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const decide = async (issueId: string, decision: Decision) => {
    setBusy(issueId);
    const response = await fetch("/api/work/intake", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, decision: decision.key }),
    });
    const body = await response.json();
    setBusy(null);
    if (!response.ok) { toast.error(body.error ?? "Could not record that decision"); return; }
    toast.success(`${body.issue.ref} ${decision.done}`);
    await load();
  };

  if (loading) return <p className="text-sm text-pebble">Loading intake…</p>;

  return (
    <div className="space-y-4">
      {!pending.length && (
        <p className="rounded-xl border border-dashed border-line px-3 py-10 text-center text-xs text-pebble">
          Nothing waiting. Intake is off unless a work item is explicitly marked pending, so an empty queue is the usual state.
        </p>
      )}

      <ul className="space-y-2">
        {pending.map((issue) => (
          <li key={issue.id} className="rounded-2xl border border-line bg-raise/60 p-3.5">
            <div className="flex items-center gap-2">
              <PriorityDot value={issue.priority} />
              <Link href={`/board/${issue.id}`} className="min-w-0 flex-1 truncate text-[13px] text-charcoal hover:text-electric-indigo">{issue.title}</Link>
              {/* Spelled out rather than via `StatusTag`, which only names the
                  statuses a board column cannot express. There are no columns
                  here, and the status is the point: Accept keeps it, so the row
                  has to say what accepting will leave the work as. */}
              <span className="shrink-0 rounded bg-veil px-1.5 py-px text-[10px] capitalize text-bark-grey">
                {issue.status.replace(/_/g, " ")}
              </span>
              <span className="font-mono text-[10px] text-pebble">{issue.ref}</span>
              <span className="text-[10.5px] text-pebble">from {issue.intakeSource ?? "user"}</span>
            </div>
            {issue.detail && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-relaxed text-bark-grey">{issue.detail}</p>}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {DECISIONS.map((decision) => (
                <button
                  key={decision.key} title={decision.hint} disabled={busy === issue.id}
                  onClick={() => void decide(issue.id, decision)}
                  className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40 ${
                    decision.key === "accept"
                      ? "bg-electric-indigo text-on-indigo"
                      : "border border-line text-charcoal hover:border-line-strong"
                  }`}
                >
                  {decision.label}
                </button>
              ))}
              <span className="ml-auto text-[10.5px] text-pebble">raised {shortDate(issue.createdAt)}</span>
            </div>
          </li>
        ))}
      </ul>

      {recent.length > 0 && (
        <section className="rounded-2xl border border-line bg-raise/60 p-4">
          <h2 className="mb-2 text-[13px] font-semibold text-charcoal">Recently triaged</h2>
          <ul className="divide-y divide-line">
            {recent.map((issue) => (
              <li key={issue.id} className="flex items-center gap-2 py-2">
                <Link href={`/board/${issue.id}`} className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal hover:text-electric-indigo">{issue.title}</Link>
                <span className="rounded bg-veil px-1.5 py-px text-[10px] capitalize text-bark-grey">{issue.intakeStatus}</span>
                <StatusTag status={issue.status} />
                <span className="w-16 shrink-0 text-right text-[10.5px] text-pebble">{shortDate(issue.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
