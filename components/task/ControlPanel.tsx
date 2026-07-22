"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Loader2, ArrowUpRight, History } from "lucide-react";
import { Composer, type RunMode } from "./Composer";
import { STATUS_LABEL, statusDot, ago } from "./transcript";
import { LEAD_PP } from "@/lib/avatars";

const SUGGESTIONS = [
  "Add a login page with JWT auth",
  "Build a REST API for todos with tests",
  "Add dark mode across the app",
];

type Task = {
  id: string;
  ref: string;
  title: string;
  status: string;
  runMode: string;
  updatedAt: number;
};

const ACTIVE = new Set(["in_progress", "todo", "blocked"]);

/**
 * The control panel: a single prompt box that turns each request into its own
 * task. There is no board to manage — the user prompts, picks a mode, and lands
 * on that task's page. Existing tasks are listed below for quick re-entry.
 */
export function ControlPanel() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<RunMode>("agent");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const d = await fetch("/api/issues").then((r) => r.json());
      const issues = (d.issues ?? []) as any[];
      // single-agent model: every top-level issue is a task
      const rows: Task[] = issues
        .filter((i) => !i.parentId)
        .map((i) => ({ id: i.id, ref: i.ref, title: i.title, status: i.status, runMode: i.runMode ?? "agent", updatedAt: i.updatedAt ?? 0 }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setTasks(rows);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => {
    poll();
    poller.current = setInterval(poll, 3000);
    return () => { if (poller.current) clearInterval(poller.current); };
  }, [poll]);

  const start = useCallback(async (raw: string, m: RunMode) => {
    const goal = raw.trim();
    if (!goal || submitting) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/issues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal, mode: m }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Request failed"); }
      const { root } = await r.json();
      router.push(`/board/${root.id}`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      toast.error(msg.includes("onboarding") ? "Finish onboarding to connect Nexotao." : msg);
      setSubmitting(false);
    }
  }, [submitting, router]);

  const active = tasks.filter((t) => ACTIVE.has(t.status));
  const recent = tasks.filter((t) => !ACTIVE.has(t.status));

  return (
    <div className="scroll-thin flex h-full min-w-0 flex-1 flex-col items-center overflow-y-auto px-8 py-10">
      <div className="w-full max-w-[600px]">
        <div className="text-center">
          <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-mist-lavender text-electric-indigo"><Sparkles className="size-5" /></span>
          <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em] text-charcoal">What should Hutao work on?</h2>
          <p className="mt-1.5 text-[14px] text-bark-grey">Type a prompt and pick a mode. Each request becomes its own task you can follow and keep chatting on.</p>
        </div>
        <div className="mt-5">
          <Composer
            value={input}
            onChange={setInput}
            mode={mode}
            onModeChange={setMode}
            onSubmit={(m) => start(input, m)}
            disabled={submitting}
            autoFocus
          />
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => start(s, mode)} disabled={submitting} className="rounded-full border border-line-strong px-3.5 py-1.5 text-[13px] text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal disabled:opacity-50">{s}</button>
          ))}
        </div>
      </div>

      {active.length > 0 && (
        <div className="mt-10 w-full max-w-[560px] text-left">
          <p className="label mb-3 flex items-center gap-1.5 text-electric-indigo">
            <Loader2 className="size-3.5 animate-spin" /> Active now · {active.length}
          </p>
          <div className="space-y-2">
            {active.map((t) => <TaskRow key={t.id} task={t} onOpen={() => router.push(`/board/${t.id}`)} active />)}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-8 w-full max-w-[560px] text-left">
          <p className="label mb-3 flex items-center gap-1.5"><History className="size-3.5" /> Recent tasks</p>
          <div className="space-y-2">
            {recent.map((t) => <TaskRow key={t.id} task={t} onOpen={() => router.push(`/board/${t.id}`)} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, onOpen, active }: { task: Task; onOpen: () => void; active?: boolean }) {
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${active ? "border-electric-indigo/30 bg-electric-indigo/[0.04] hover:border-electric-indigo" : "border-line bg-paper-white hover:border-line-strong"}`}
    >
      <img src={LEAD_PP} alt="Hutao" className="size-7 shrink-0 rounded-lg object-cover" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-charcoal">{task.title}</span>
        <span className="mt-0.5 block font-mono text-[10.5px] text-pebble">{task.ref} · {task.runMode} · {ago(task.updatedAt)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-bark-grey">
        <span className={`size-[7px] rounded-full ${statusDot(task.status)}`} /> {STATUS_LABEL[task.status] ?? task.status}
      </span>
      {active && <ArrowUpRight className="size-4 shrink-0 text-electric-indigo" />}
    </button>
  );
}
