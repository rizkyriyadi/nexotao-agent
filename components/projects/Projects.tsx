"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Plus, Columns3, FolderOpen, Check } from "lucide-react";

type Project = { id: string; name: string; path: string; sessions: number; tasks: number };

const TONE = ["bg-electric-indigo/12 text-electric-indigo", "bg-lichen-green/12 text-lichen-green", "bg-sapphire-link/12 text-sapphire-link"];

export function Projects() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((d) => { setProjects(d.projects ?? []); setActiveId(d.activeId); });
  }, []);

  async function open(id: string) {
    await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    router.push("/board");
  }

  return (
    <div className="scroll-thin h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-9 py-8">
        <p className="label">Workspaces</p>
        <div className="mt-1 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-charcoal">Projects</h1>
            <p className="mt-1 flex items-center gap-1.5 text-[14px] text-bark-grey">
              <Lock className="size-3.5 text-pebble" /> Each project has its own isolated workspace — agents never cross between them.
            </p>
          </div>
          <Link href="/onboarding" className="flex h-9 items-center gap-2 rounded-full bg-electric-indigo px-4 text-[13px] font-medium text-white transition-colors hover:bg-deep-violet"><Plus className="size-4" /> New project</Link>
        </div>

        {projects.length === 0 ? (
          <div className="mt-10 flex flex-col items-center rounded-3xl border border-dashed border-line-strong py-14 text-center">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-mist-lavender text-electric-indigo"><FolderOpen className="size-5" /></span>
            <p className="mt-3 text-[15px] font-medium text-charcoal">No projects yet</p>
            <p className="mt-1 text-[13px] text-bark-grey">Add a folder to get started.</p>
            <Link href="/onboarding" className="mt-4 flex h-9 items-center gap-2 rounded-full bg-charcoal px-4 text-[13px] font-medium text-warm-bone">Add project</Link>
          </div>
        ) : (
          <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p, i) => (
              <div key={p.id} className="flex flex-col rounded-3xl border border-line bg-paper-white p-5 transition-colors hover:border-line-strong">
                <div className="flex items-center gap-3">
                  <span className={`flex size-11 items-center justify-center rounded-2xl text-[15px] font-semibold uppercase ${TONE[i % TONE.length]}`}>{p.name.slice(0, 2)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[15px] font-medium text-charcoal">
                      {p.name}
                      {p.id === activeId && <Check className="size-3.5 shrink-0 text-electric-indigo" />}
                    </p>
                    <p className="truncate font-mono text-[11.5px] text-pebble">{p.path}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-4 text-[13px] text-bark-grey">
                  <span className="flex items-center gap-1.5"><Columns3 className="size-4 text-pebble" /> {p.tasks} tasks</span>
                </div>
                <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
                  <span className="flex items-center gap-1 rounded-full bg-lichen-green/10 px-2.5 py-1 font-mono text-[10px] text-lichen-green"><Lock className="size-3" /> isolated</span>
                  <button onClick={() => open(p.id)} className="ml-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[12.5px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal"><FolderOpen className="size-3.5" /> Open</button>
                </div>
              </div>
            ))}
            <Link href="/onboarding" className="flex min-h-[188px] flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-line-strong text-pebble transition-colors hover:border-bark-grey hover:text-bark-grey">
              <span className="flex size-11 items-center justify-center rounded-2xl border border-line-strong"><Plus className="size-5" /></span>
              <span className="text-[13.5px]">Add a project</span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
