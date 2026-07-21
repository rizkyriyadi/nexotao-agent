"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, Search, Zap, CalendarDays, Plus, Plug, ArrowRight, MessageSquare, Bot, Users } from "lucide-react";

type Project = { id: string; name: string; path: string; mode: "single" | "multi"; agents: { name: string; scope: string }[] } | null;
type Session = { id: string; title: string; updatedAt: number; count: number };
type Task = { id: string; col: string };

const AV = ["bg-electric-indigo/12 text-electric-indigo", "bg-lichen-green/12 text-lichen-green", "bg-sapphire-link/12 text-sapphire-link", "bg-alarm-red/12 text-alarm-red"];

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
}
function Bar({ pct, tone = "indigo" }: { pct: number; tone?: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line">
      <span className={`block h-full rounded-full ${tone === "indigo" ? "bg-electric-indigo" : "bg-mist-lavender-2"}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

export function Overview() {
  const [project, setProject] = useState<Project>(null);
  const [model, setModel] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((d) => { setProject(d.project); setModel(d.model ?? ""); });
    fetch("/api/sessions").then((r) => r.json()).then((d) => setSessions(d.sessions ?? []));
    fetch("/api/tasks").then((r) => r.json()).then((d) => setTasks(d.tasks ?? []));
  }, []);

  const doneTasks = tasks.filter((t) => t.col === "done").length;
  const taskPct = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
  const isMulti = project?.mode === "multi";
  const agents = project?.agents ?? [];

  return (
    <div className="scroll-thin h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-9 py-6">
        {/* header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-full bg-electric-indigo/12 text-[13px] font-semibold text-electric-indigo">{(project?.name ?? "··").slice(0, 2).toUpperCase()}</span>
            <div className="leading-tight">
              <p className="text-[14px] font-medium text-charcoal">Your workspace</p>
              <p className="font-mono text-[11px] text-pebble">local · {project?.path ?? "~"}</p>
            </div>
          </div>
          <div className="flex items-center gap-5 text-[13px] text-bark-grey">
            <span className="flex items-center gap-1.5"><Zap className="size-4 text-pebble" /> {model || "—"}</span>
            <span className="flex items-center gap-1.5"><CalendarDays className="size-4 text-pebble" /> {isMulti ? "multi-agent" : "single agent"}</span>
          </div>
        </div>

        <p className="label mt-8">Workspace</p>
        <h1 className="mt-1 text-[40px] font-semibold leading-none tracking-[-0.02em] text-charcoal">{project?.name ?? "No project"}</h1>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/chat" className="flex h-8 items-center gap-1.5 rounded-full bg-electric-indigo px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-deep-violet"><Sparkles className="size-3.5" /> Ask AI</Link>
            <Link href="/chat" className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[13px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal"><Plus className="size-3.5" /> New session</Link>
            <Link href="/board" className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[13px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal"><Plus className="size-3.5" /> New task</Link>
            <Link href="/orchestrator" className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[13px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal"><Plug className="size-3.5" /> Agents</Link>
          </div>
          <div className="flex h-9 w-[240px] items-center gap-2 rounded-full border border-line-strong px-3.5">
            <Search className="size-4 text-pebble" />
            <input placeholder="Search…" className="flex-1 bg-transparent text-[13px] text-charcoal placeholder:text-pebble focus:outline-none" />
          </div>
        </div>

        {/* cards */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="flex flex-col justify-between rounded-3xl bg-mist-lavender p-6">
            <div>
              <h2 className="text-[22px] font-semibold leading-snug tracking-[-0.01em] text-charcoal">Let the agent do the grind.</h2>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-bark-grey">Describe a task — it reads, edits, and runs code in {project?.name ?? "your project"}, with your approval.</p>
            </div>
            <Link href="/chat" className="mt-6 inline-flex h-9 w-fit items-center gap-2 rounded-full bg-electric-indigo px-4 text-[13px] font-medium text-white transition-colors hover:bg-deep-violet">New session <ArrowRight className="size-4" /></Link>
          </div>

          <div className="flex flex-col justify-between rounded-3xl border border-line bg-paper-white p-5">
            <div>
              <p className="text-[15px] font-semibold text-charcoal">Jump back in</p>
              <p className="mt-0.5 text-[12.5px] text-bark-grey">Your latest session.</p>
            </div>
            {sessions[0] ? (
              <Link href={`/chat?session=${sessions[0].id}`} className="mt-4 flex items-center gap-3 rounded-2xl border border-line p-3 transition-colors hover:border-line-strong">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-mist-lavender text-electric-indigo"><MessageSquare className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-charcoal">{sessions[0].title}</span>
                  <span className="block font-mono text-[11px] text-pebble">{sessions[0].count} msgs · {ago(sessions[0].updatedAt)}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-pebble" />
              </Link>
            ) : (
              <p className="mt-4 rounded-2xl border border-dashed border-line-strong p-4 text-center text-[13px] text-pebble">No sessions yet.</p>
            )}
          </div>

          <div className="rounded-3xl border border-line bg-paper-white p-5">
            <p className="text-[15px] font-semibold text-charcoal">This project</p>
            <p className="mt-0.5 text-[12.5px] text-bark-grey">Activity so far</p>
            <div className="mt-5 grid grid-cols-2">
              <div className="pr-5"><p className="label !text-[10px]">Sessions</p><p className="mt-1 text-[26px] font-semibold leading-none text-charcoal">{sessions.length}</p></div>
              <div className="border-l border-line pl-5"><p className="label !text-[10px]">Tasks done</p><p className="mt-1 text-[26px] font-semibold leading-none text-charcoal">{doneTasks}/{tasks.length}</p></div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3"><Bar pct={sessions.length ? 100 : 0} /><Bar pct={taskPct} tone="lavender" /></div>
          </div>
        </div>

        {/* recent + agents */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-line bg-paper-white p-5 lg:col-span-2">
            <p className="mb-3 text-[15px] font-semibold text-charcoal">Recent sessions</p>
            {sessions.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-pebble">No sessions yet — start one from the chat.</p>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-line pb-2 text-[11px] text-pebble">
                  <span>Session</span><span>Messages</span><span className="text-right">Updated</span>
                </div>
                {sessions.slice(0, 6).map((s) => (
                  <Link key={s.id} href={`/chat?session=${s.id}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-line py-3 last:border-0 hover:bg-black/[0.01]">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-mist-lavender text-electric-indigo"><MessageSquare className="size-4" /></span>
                      <span className="truncate text-[13px] text-charcoal">{s.title}</span>
                    </div>
                    <span className="w-16 text-center font-mono text-[13px] text-charcoal">{s.count}</span>
                    <span className="text-right font-mono text-[11px] text-pebble">{ago(s.updatedAt)}</span>
                  </Link>
                ))}
              </>
            )}
          </div>

          <div className="rounded-3xl border border-line bg-paper-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[15px] font-semibold text-charcoal">{isMulti ? "Agent team" : "Agent"}</p>
              {isMulti && <Link href="/orchestrator" className="text-[12px] text-sapphire-link hover:underline">Open</Link>}
            </div>
            {isMulti && agents.length ? (
              <ul className="space-y-3.5">
                {agents.map((a, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className={`flex size-9 items-center justify-center rounded-full text-[13px] font-semibold ${AV[i % AV.length]}`}>{a.name.slice(0, 2)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-charcoal">{a.name}</p>
                      <p className="truncate text-[11.5px] text-pebble">{a.scope}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-3 rounded-2xl border border-line p-4">
                <span className="flex size-9 items-center justify-center rounded-full bg-electric-indigo/12 text-electric-indigo"><Bot className="size-4" /></span>
                <div>
                  <p className="text-[13.5px] font-medium text-charcoal">Single agent</p>
                  <p className="text-[11.5px] text-pebble">One agent handles everything.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
