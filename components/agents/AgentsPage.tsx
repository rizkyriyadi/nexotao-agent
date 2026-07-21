"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Users, Clock, CheckCircle2, XCircle, Network, ChevronRight } from "lucide-react";

type Agent = { name: string; scope: string };
type Hist = { id: string; agent: string; task: string; summary: string; ok: boolean; ts: number };

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const AV = [
  "bg-electric-indigo/12 text-electric-indigo",
  "bg-lichen-green/12 text-lichen-green",
  "bg-sapphire-link/12 text-sapphire-link",
  "bg-alarm-red/12 text-alarm-red",
];

export function AgentsPage() {
  const [team, setTeam] = useState<Agent[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [runs, setRuns] = useState<Hist[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((d) => {
      setTeam(d.project?.agents ?? []);
      setMode(d.project?.mode ?? null);
    }).catch(() => {});
    fetch("/api/agent-runs").then((r) => r.json()).then((d) => setRuns(d.runs ?? [])).catch(() => {});
  }, []);

  // in single-agent mode there's still one worker
  const agents: Agent[] = useMemo(
    () => (mode === "single" ? [{ name: "Agent", scope: "Handles every task in this project" }] : team),
    [mode, team],
  );

  useEffect(() => {
    if (!selected && agents.length) setSelected(agents[0].name);
  }, [agents, selected]);

  const countFor = (name: string) => runs.filter((r) => r.agent === name).length;
  const selectedRuns = runs.filter((r) => r.agent === selected).sort((a, b) => b.ts - a.ts);

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* agent list */}
      <div className="flex w-[380px] shrink-0 flex-col border-r border-line">
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-6">
          <Users className="size-4 text-electric-indigo" />
          <h1 className="text-[15px] font-medium text-charcoal">Agent team</h1>
          <span className="ml-auto font-mono text-[11px] text-pebble">{agents.length} {agents.length === 1 ? "agent" : "agents"}</span>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
          {agents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-strong px-5 py-10 text-center">
              <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-mist-lavender text-electric-indigo"><Bot className="size-5" /></span>
              <p className="mt-3 text-[13.5px] font-medium text-charcoal">No agents configured</p>
              <p className="mt-1 text-[12.5px] text-bark-grey">Pick a team in onboarding, or the lead works solo.</p>
              <Link href="/onboarding" className="mt-4 inline-flex rounded-lg border border-line-strong px-3 py-1.5 text-[13px] text-charcoal transition-colors hover:border-charcoal">Configure team</Link>
            </div>
          ) : (
            <div className="space-y-2">
              {agents.map((a, i) => {
                const on = selected === a.name;
                const n = countFor(a.name);
                return (
                  <button
                    key={a.name}
                    onClick={() => setSelected(a.name)}
                    className={`flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors ${on ? "border-electric-indigo bg-electric-indigo/[0.04]" : "border-line hover:border-line-strong"}`}
                  >
                    <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl text-[12px] font-semibold uppercase ${AV[i % AV.length]}`}>{a.name.slice(0, 2)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-charcoal">{a.name}</span>
                      <span className="block truncate text-[12.5px] text-bark-grey">{a.scope}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-pebble">
                      {n} {n === 1 ? "task" : "tasks"} <ChevronRight className="size-3.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-line p-3">
          <Link href="/orchestrator" className="flex items-center justify-center gap-2 rounded-xl border border-line-strong px-3 py-2.5 text-[13.5px] font-medium text-charcoal transition-colors hover:border-charcoal">
            <Network className="size-4 text-electric-indigo" /> Give the team a task
          </Link>
        </div>
      </div>

      {/* selected agent's task history */}
      <div className="flex min-w-0 flex-1 flex-col bg-warm-bone">
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-6">
          {selected ? (
            <>
              <span className="flex size-7 items-center justify-center rounded-lg bg-mist-lavender text-[11px] font-semibold uppercase text-electric-indigo">{selected.slice(0, 2)}</span>
              <span className="text-[14px] font-medium text-charcoal">{selected}</span>
              <span className="flex items-center gap-1.5 text-[12px] text-bark-grey"><Clock className="size-3.5" /> task history</span>
            </>
          ) : (
            <span className="text-[14px] text-pebble">Select an agent</span>
          )}
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto px-6 py-5">
          {selected && selectedRuns.length === 0 ? (
            <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
              <p className="text-[13.5px] font-medium text-charcoal">No tasks yet</p>
              <p className="mt-1 text-[12.5px] text-bark-grey">{selected} hasn't worked on anything in this project. Runs it participates in will show up here.</p>
            </div>
          ) : (
            <ul className="mx-auto max-w-[680px] space-y-2.5">
              {selectedRuns.map((h) => (
                <li key={h.id} className="rounded-2xl border border-line bg-paper-white p-4">
                  <div className="flex items-center gap-2">
                    {h.ok ? <CheckCircle2 className="size-4 shrink-0 text-lichen-green" /> : <XCircle className="size-4 shrink-0 text-alarm-red" />}
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-charcoal">{h.task}</span>
                    <span className="shrink-0 font-mono text-[11px] text-pebble">{ago(h.ts)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-bark-grey">{h.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
