"use client";

/* Modules: the durable containers, as against cycles which are the temporary
   ones. A module is a piece of the product with a lead — it does not end, so it
   carries a target date rather than a range, and no burn-down. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ProgressBar } from "./charts";
import { shortDate } from "./parts";
import type { Module } from "@/lib/work-model";

type Row = Module & { progress: { total: number; completed: number; pending: number; points: number; completedPoints: number } };

export function ModulesView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ name: "", leadAgentId: "" });

  const load = useCallback(async () => {
    // The agent list rides along with the board payload rather than a second
    // endpoint — the lead picker is the only thing here that needs it.
    const [modulesResponse, boardResponse] = await Promise.all([
      fetch("/api/work/modules", { cache: "no-store" }),
      fetch("/api/work/issues", { cache: "no-store" }),
    ]);
    const modulesBody = await modulesResponse.json();
    const boardBody = await boardResponse.json();
    if (modulesResponse.ok) setRows(modulesBody.modules); else toast.error(modulesBody.error ?? "Could not load modules");
    if (boardResponse.ok) setAgents(boardBody.agents ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!draft.name.trim()) return;
    const response = await fetch("/api/work/modules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draft.name.trim(), leadAgentId: draft.leadAgentId || null }),
    });
    const body = await response.json();
    if (!response.ok) { toast.error(body.error ?? "Could not create that module"); return; }
    toast.success(`${body.module.name} created`);
    setDraft({ name: "", leadAgentId: "" });
    await load();
  };

  if (loading) return <p className="text-sm text-pebble">Loading modules…</p>;

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => { event.preventDefault(); void create(); }}
        className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-white/60 p-3"
      >
        <label className="flex flex-col gap-1 text-[11px] text-pebble">
          Name
          <input
            value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="Billing" aria-label="Module name"
            className="w-48 rounded-lg border border-line bg-white px-2 py-1 text-[12.5px] text-charcoal outline-none focus:border-line-strong"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-pebble">
          Lead
          <select
            value={draft.leadAgentId} onChange={(event) => setDraft({ ...draft, leadAgentId: event.target.value })}
            aria-label="Module lead"
            className="rounded-lg border border-line bg-white px-2 py-1 text-[12.5px] text-charcoal outline-none focus:border-line-strong"
          >
            <option value="">No lead</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <button type="submit" disabled={!draft.name.trim()}
          className="rounded-lg bg-electric-indigo px-3 py-1.5 text-[12px] text-white disabled:opacity-40">
          Add module
        </button>
      </form>

      {!rows.length && <p className="rounded-xl border border-dashed border-line px-3 py-10 text-center text-xs text-pebble">No modules yet. A module groups work by the part of the product it belongs to.</p>}

      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((record) => (
          <li key={record.id}>
            <Link href={`/work/modules/${record.id}`} className="block rounded-2xl border border-line bg-white/60 p-3.5 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-charcoal">{record.name}</h2>
                {record.completedAt && <span className="rounded bg-black/[.05] px-1.5 py-px text-[10px] text-pebble">completed</span>}
              </div>
              <p className="mt-0.5 text-[11px] text-pebble">
                {agents.find((agent) => agent.id === record.leadAgentId)?.name ?? "No lead"}
                {record.targetDate ? ` · due ${shortDate(record.targetDate)}` : ""}
              </p>
              <div className="mt-2.5"><ProgressBar completed={record.progress.completed} total={record.progress.total} /></div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
