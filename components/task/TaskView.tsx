"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import { Button } from "../ui/button";
import { Composer, type RunMode } from "./Composer";
import { Transcript, STATUS_LABEL, statusDot, TOOL_LABEL } from "./transcript";
import { useRunStream } from "./use-run-stream";
import { LEAD_PP } from "@/lib/avatars";

type Issue = {
  id: string; ref: string; title: string; detail: string; status: string;
  runMode: RunMode; summary: string; createdAt: number; updatedAt: number;
  assigneeAgentId: string | null;
};
type Comment = { id: string; authorType: string; body: string; createdAt: number };
type Run = { id: string; status: string; startedAt: number | null; queuedAt: number | null; finishedAt: number | null };
type Detail = { issue: Issue; comments: Comment[]; runs: Run[]; agents: { id: string; name: string }[] };

type TimelineItem =
  | { kind: "user"; text: string; ts: number; key: string }
  | { kind: "run"; runId: string; status: string; ts: number; live: boolean; key: string };

const ACTIVE = new Set(["in_progress", "todo", "blocked", "queued", "running", "waiting"]);

export function TaskView({ id }: { id: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<RunMode>("agent");
  const [sending, setSending] = useState(false);
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const modeTouched = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/issues/${id}`);
      if (r.status === 404) { setNotFound(true); return; }
      const d = await r.json();
      if (d?.issue) {
        setDetail({ issue: d.issue, comments: d.comments ?? [], runs: d.runs ?? [], agents: d.agents ?? [] });
        if (!modeTouched.current) setMode((d.issue.runMode as RunMode) ?? "agent");
      }
    } catch { /* keep last */ }
  }, [id]);

  useEffect(() => {
    load();
    poller.current = setInterval(load, 2500);
    return () => { if (poller.current) clearInterval(poller.current); };
  }, [load]);

  const issue = detail?.issue;
  const running = issue ? ACTIVE.has(issue.status) : false;

  // keep the view pinned to the latest activity while a run streams
  useEffect(() => {
    if (running && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [detail, running]);

  const send = useCallback(async (m: RunMode) => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/issues/${id}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text, mode: m }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Couldn't send"); }
      setInput("");
      await load();
    } catch (err: any) {
      toast.error(String(err?.message ?? err));
    } finally {
      setSending(false);
    }
  }, [input, sending, id, load]);

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-[14px] text-bark-grey">This task doesn&apos;t exist.</p>
        <Button size="sm" variant="outline" onClick={() => router.push("/board")}><ArrowLeft className="size-4" /> Back to control panel</Button>
      </div>
    );
  }

  if (!issue) {
    return <div className="flex h-full items-center justify-center text-pebble"><Loader2 className="size-5 animate-spin" /></div>;
  }

  // build the conversation timeline: initial prompt, follow-up messages, and runs
  const runs = [...detail!.runs].sort((a, b) => (a.startedAt ?? a.queuedAt ?? 0) - (b.startedAt ?? b.queuedAt ?? 0));
  const newestRunId = runs.length ? runs[runs.length - 1].id : null;
  const items: TimelineItem[] = [
    { kind: "user" as const, text: issue.detail || issue.title, ts: issue.createdAt, key: "goal" },
    ...detail!.comments.filter((c) => c.authorType === "user").map((c) => ({ kind: "user" as const, text: c.body, ts: c.createdAt, key: `c-${c.id}` })),
    ...runs.map((run) => ({
      kind: "run" as const, runId: run.id, status: run.status,
      ts: run.startedAt ?? run.queuedAt ?? 0, live: run.id === newestRunId && running, key: `r-${run.id}`,
    })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <button onClick={() => router.push("/board")} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-pebble transition-colors hover:bg-black/[0.04] hover:text-charcoal" title="Back to control panel">
          <ArrowLeft className="size-4" />
        </button>
        <img src={LEAD_PP} alt="Hutao" className="size-7 shrink-0 rounded-lg object-cover" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14.5px] font-medium text-charcoal">{issue.title}</h1>
          <p className="font-mono text-[10.5px] text-pebble">{issue.ref} · {issue.runMode}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-bark-grey">
          {running && <Loader2 className="size-3.5 animate-spin text-electric-indigo" />}
          <span className={`size-[6px] rounded-full ${statusDot(issue.status)}`} /> {STATUS_LABEL[issue.status] ?? issue.status}
        </span>
        <Button variant="outline" size="sm" className="gap-1.5 rounded-lg" onClick={() => router.push("/board")}><Plus className="size-3.5" /> New task</Button>
      </header>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-5 px-6 py-7">
          {items.map((item) => item.kind === "user"
            ? <UserBubble key={item.key} text={item.text} />
            : <RunSection key={item.key} runId={item.runId} status={item.status} live={item.live} />)}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-canvas/60 px-6 py-4">
        <div className="mx-auto max-w-[760px]">
          <Composer
            value={input}
            onChange={setInput}
            mode={mode}
            onModeChange={(m) => { modeTouched.current = true; setMode(m); }}
            onSubmit={send}
            disabled={sending}
            placeholder={running ? "Queue a follow-up — Hutao picks it up next…" : "Reply to continue this task…"}
          />
          <p className="mt-2 text-center text-[11.5px] text-pebble">
            {running ? "A run is in progress — your message will be queued." : "Sending a message reopens this task and wakes Hutao."}
          </p>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-electric-indigo px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-sm">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function RunSection({ runId, status, live }: { runId: string; status: string; live: boolean }) {
  const { log, approval, terminal } = useRunStream(runId, { live });
  const approve = useCallback(async (decision: "allow" | "deny") => {
    if (!approval) return;
    await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: approval.runId, id: approval.id, decision }) }).catch(() => {});
  }, [approval]);

  const waiting = status === "queued" || status === "todo" ? "Queued — Hutao will start shortly…" : "Working…";

  return (
    <div className="flex gap-3">
      <img src={LEAD_PP} alt="Hutao" className="mt-0.5 size-7 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-paper-white px-4 py-3.5">
        {approval && !terminal && (
          <div className="mb-3 rounded-xl border border-electric-indigo bg-electric-indigo/[0.04] p-3.5">
            <p className="text-[13px] font-medium text-charcoal">Approve {TOOL_LABEL[approval.name] ?? approval.name}?</p>
            <code className="mt-1.5 block break-words text-[12px] text-bark-grey">{approval.input?.command ?? approval.input?.path ?? approval.name}</code>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => approve("deny")}>Deny</Button>
              <Button size="sm" onClick={() => approve("allow")}>Allow</Button>
            </div>
          </div>
        )}
        <Transcript log={log} waiting={waiting} />
      </div>
    </div>
  );
}
