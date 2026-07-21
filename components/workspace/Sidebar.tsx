"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Lock, Plus, MessageSquare } from "lucide-react";
import { Button } from "../ui/button";

type Project = { id: string; name: string; path: string };
type Session = { id: string; title: string; updatedAt: number; count: number };

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function Sidebar() {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((d) => { setProjects(d.projects ?? []); setActiveId(d.activeId); });
    fetch("/api/sessions").then((r) => r.json()).then((d) => setSessions(d.sessions ?? []));
  }, []);

  const active = projects.find((p) => p.id === activeId) ?? projects[0];

  function newSession() {
    // don't create an empty session — it's created on the first message
    router.push("/chat");
    router.refresh();
  }
  async function switchProject(id: string) {
    setMenu(false);
    await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    router.push("/chat");
    router.refresh();
  }

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-line">
      <div className="relative flex h-14 items-center px-3">
        <button onClick={() => setMenu((v) => !v)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-[14px] font-medium text-charcoal transition-colors hover:bg-black/[0.03]">
          <span className="flex size-6 items-center justify-center rounded-lg bg-mist-lavender text-[10px] font-semibold uppercase text-electric-indigo">{(active?.name ?? "··").slice(0, 2)}</span>
          <span className="truncate">{active?.name ?? "No project"}</span>
          <ChevronDown className="ml-auto size-4 text-pebble" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute left-3 right-3 top-[52px] z-20 rounded-xl border border-line-strong bg-popover p-1.5 shadow-float">
              <p className="label px-2 py-1.5">Projects</p>
              {projects.map((p) => (
                <button key={p.id} onClick={() => switchProject(p.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-black/[0.03]">
                  <span className="flex size-6 items-center justify-center rounded-lg bg-mist-lavender text-[10px] font-semibold uppercase text-electric-indigo">{p.name.slice(0, 2)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-charcoal">{p.name}</span>
                    <span className="block truncate font-mono text-[11px] text-pebble">{p.path}</span>
                  </span>
                  <Lock className="size-3 shrink-0 text-pebble" />
                  {p.id === activeId && <Check className="size-4 shrink-0 text-electric-indigo" />}
                </button>
              ))}
              <div className="my-1 h-px bg-line" />
              <Link href="/onboarding" onClick={() => setMenu(false)} className="flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-bark-grey transition-colors hover:bg-black/[0.03] hover:text-charcoal">
                <Plus className="size-4 text-pebble" /> Add project…
              </Link>
            </div>
          </>
        )}
      </div>

      <div className="px-3 pb-1">
        <Button variant="outline" size="sm" className="w-full justify-start gap-2 rounded-lg" onClick={newSession}>
          <Plus className="size-4" /> New session
        </Button>
      </div>

      <div className="px-4 pb-1 pt-4"><span className="label">Sessions</span></div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2">
        {sessions.length === 0 ? (
          <p className="px-2.5 py-2 text-[12.5px] text-pebble">No sessions yet.</p>
        ) : (
          <ul>
            {sessions.map((s) => (
              <li key={s.id}>
                <button onClick={() => router.push(`/chat?session=${s.id}`)} className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-black/[0.03]">
                  <MessageSquare className="size-4 shrink-0 text-pebble" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] leading-snug text-bark-grey group-hover:text-charcoal">{s.title}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-pebble">{s.count} msgs · {ago(s.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
