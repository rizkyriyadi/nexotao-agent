"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Ban, Loader2, Play, Plus, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Composer, type RunMode } from "./Composer";
import { Transcript, STATUS_LABEL, statusDot, TOOL_LABEL } from "./transcript";
import { useRunStream } from "./use-run-stream";
import { agentAvatar } from "@/lib/avatars";

type Issue = {
  id: string; ref: string; title: string; detail: string; status: string;
  runMode: RunMode; summary: string; createdAt: number; updatedAt: number;
  assigneeAgentId: string | null;
};
type Comment = { id: string; authorType: string; body: string; createdAt: number };
type Run = { id: string; status: string; startedAt: number | null; queuedAt: number | null; finishedAt: number | null };
type AgentLite = { id: string; name: string; avatar?: string | null };
type DocLite = { key: string; body?: string | null };
type Detail = { issue: Issue; comments: Comment[]; runs: Run[]; agents: AgentLite[]; documents: DocLite[] };

type Decision = { q: string; options: string[] };

type TimelineItem =
  | { kind: "user"; text: string; ts: number; key: string }
  | { kind: "run"; runId: string; status: string; ts: number; live: boolean; key: string };

const ACTIVE = new Set(["in_progress", "todo", "blocked", "queued", "running", "waiting"]);

/** Pull the optional machine-readable decisions block a plan run may append as a
 *  trailing HTML comment. Forgiving: anything malformed yields no chips. */
function parseDecisions(body: string | null | undefined): Decision[] {
  if (!body) return [];
  const match = body.match(/<!--\s*decisions\s*([\s\S]*?)-->/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d && typeof d.q === "string" && Array.isArray(d.options))
      .map((d) => ({ q: String(d.q), options: d.options.filter((o: unknown) => typeof o === "string").slice(0, 6) }))
      .filter((d) => d.options.length > 0)
      .slice(0, 4);
  } catch { return []; }
}

export function TaskView({ id }: { id: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<RunMode>("agent");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [othering, setOthering] = useState<Record<number, boolean>>({});
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const modeTouched = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/issues/${id}`);
      if (r.status === 404) { setNotFound(true); return; }
      const d = await r.json();
      if (d?.issue) {
        setDetail({ issue: d.issue, comments: d.comments ?? [], runs: d.runs ?? [], agents: d.agents ?? [], documents: d.documents ?? [] });
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

  const avatar = useMemo(() => {
    const assignee = detail?.agents.find((a) => a.id === issue?.assigneeAgentId);
    return agentAvatar(assignee?.avatar ?? null);
  }, [detail, issue]);

  // keep the view pinned to the latest activity while a run streams
  useEffect(() => {
    if (running && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [detail, running]);

  const postMessage = useCallback(async (text: string, m: RunMode) => {
    const r = await fetch(`/api/issues/${id}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text, mode: m }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Couldn't send"); }
    await load();
  }, [id, load]);

  const send = useCallback(async (m: RunMode) => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await postMessage(text, m);
      setInput("");
    } catch (err: any) {
      toast.error(String(err?.message ?? err));
    } finally {
      setSending(false);
    }
  }, [input, sending, postMessage]);

  const cancel = useCallback(async (runId: string) => {
    if (cancelling) return;
    setCancelling(true);
    try {
      const r = await fetch("/api/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Couldn't cancel"); }
      toast.success("Run cancelled");
      await load();
    } catch (err: any) {
      toast.error(String(err?.message ?? err));
    } finally {
      setCancelling(false);
    }
  }, [cancelling, load]);

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
  const liveRunId = running ? newestRunId : null;
  const items: TimelineItem[] = [
    { kind: "user" as const, text: issue.detail || issue.title, ts: issue.createdAt, key: "goal" },
    ...detail!.comments.filter((c) => c.authorType === "user").map((c) => ({ kind: "user" as const, text: c.body, ts: c.createdAt, key: `c-${c.id}` })),
    ...runs.map((run) => ({
      kind: "run" as const, runId: run.id, status: run.status,
      ts: run.startedAt ?? run.queuedAt ?? 0, live: run.id === newestRunId && running, key: `r-${run.id}`,
    })),
  ].sort((a, b) => a.ts - b.ts);

  const planDoc = detail!.documents.find((d) => d.key === "plan");
  const decisions = parseDecisions(planDoc?.body);
  // Offer plan execution while the task is still in Plan mode and idle. Executing
  // reopens it in Agent mode, which flips runMode and hides this panel.
  const showPlanActions = Boolean(planDoc) && issue.runMode === "plan" && !running;

  const executePlan = async () => {
    const lines = decisions
      .map((d, i) => (answers[i] ? `- ${d.q}: ${answers[i]}` : null))
      .filter(Boolean);
    const body = lines.length
      ? `Execute the plan above in Agent mode. My decisions:\n${lines.join("\n")}`
      : "Execute the plan above in Agent mode.";
    setSending(true);
    try {
      await postMessage(body, "agent");
      setMode("agent");
      modeTouched.current = true;
    } catch (err: any) {
      toast.error(String(err?.message ?? err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-gradient-to-b from-mist-lavender/40 via-canvas to-warm-bone">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line/70 bg-paper-white/70 px-5 backdrop-blur">
        <button onClick={() => router.push("/board")} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-pebble transition-colors hover:bg-black/[0.04] hover:text-charcoal" title="Back to control panel">
          <ArrowLeft className="size-4" />
        </button>
        <img src={avatar} alt="Hutao" className="size-8 shrink-0 rounded-xl object-cover ring-1 ring-line" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14.5px] font-medium text-charcoal">{issue.title}</h1>
          <p className="font-mono text-[10.5px] text-pebble">{issue.ref} · {issue.runMode}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-bark-grey">
          {running && <Loader2 className="size-3.5 animate-spin text-electric-indigo" />}
          <span className={`size-[6px] rounded-full ${statusDot(issue.status)}`} /> {STATUS_LABEL[issue.status] ?? issue.status}
        </span>
        {liveRunId && (
          <Button variant="outline" size="sm" className="gap-1.5 rounded-lg border-alarm-red/30 text-alarm-red hover:bg-alarm-red/[0.06]" onClick={() => cancel(liveRunId)} disabled={cancelling}>
            {cancelling ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />} Cancel
          </Button>
        )}
        <Button variant="outline" size="sm" className="gap-1.5 rounded-lg" onClick={() => router.push("/board")}><Plus className="size-3.5" /> New task</Button>
      </header>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-6 px-6 py-8">
          {items.map((item) => item.kind === "user"
            ? <UserBubble key={item.key} text={item.text} />
            : <RunSection key={item.key} runId={item.runId} status={item.status} live={item.live} avatar={avatar} />)}

          {showPlanActions && (
            <PlanActions
              decisions={decisions}
              answers={answers}
              othering={othering}
              onPick={(i, value) => { setOthering((o) => ({ ...o, [i]: false })); setAnswers((a) => ({ ...a, [i]: value })); }}
              onOther={(i) => { setOthering((o) => ({ ...o, [i]: true })); setAnswers((a) => ({ ...a, [i]: "" })); }}
              onOtherText={(i, value) => setAnswers((a) => ({ ...a, [i]: value }))}
              onExecute={() => void executePlan()}
              disabled={sending}
            />
          )}
        </div>
      </div>

      <div className="pointer-events-none shrink-0 bg-gradient-to-t from-warm-bone via-warm-bone/90 to-transparent px-6 pb-5 pt-10">
        <div className="pointer-events-auto mx-auto max-w-[760px]">
          <Composer
            value={input}
            onChange={setInput}
            mode={mode}
            onModeChange={(m) => { modeTouched.current = true; setMode(m); }}
            onSubmit={send}
            disabled={sending}
            placeholder={running ? "Queue a follow-up — Hutao picks it up next…" : "Reply to continue this task…"}
            hint={running ? "A run is in progress — your message will be queued." : "Sending a message reopens this task and wakes Hutao."}
          />
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-3xl rounded-br-lg bg-electric-indigo px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-sm">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function RunSection({ runId, status, live, avatar }: { runId: string; status: string; live: boolean; avatar: string }) {
  const { log, approval, terminal } = useRunStream(runId, { live });
  const approve = useCallback(async (decision: "allow" | "deny") => {
    if (!approval) return;
    await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: approval.runId, id: approval.id, decision }) }).catch(() => {});
  }, [approval]);

  const waiting = status === "queued" || status === "todo" ? "Queued — Hutao will start shortly…" : "Working…";

  return (
    <div className="flex gap-3">
      <img src={avatar} alt="Hutao" className="mt-0.5 size-8 shrink-0 rounded-xl object-cover ring-1 ring-line" />
      <div className="min-w-0 flex-1 rounded-3xl rounded-tl-lg border border-line/70 bg-paper-white/90 px-4 py-3.5 shadow-sm backdrop-blur">
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

/** Plan-mode footer: any decisions the plan asked for (as option chips + a free
 *  "Other" field), plus the one-click Execute button that reruns in Agent mode. */
function PlanActions({
  decisions, answers, othering, onPick, onOther, onOtherText, onExecute, disabled,
}: {
  decisions: Decision[];
  answers: Record<number, string>;
  othering: Record<number, boolean>;
  onPick: (i: number, value: string) => void;
  onOther: (i: number) => void;
  onOtherText: (i: number, value: string) => void;
  onExecute: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="ml-11 rounded-3xl border border-electric-indigo/25 bg-mist-lavender/40 p-4 shadow-sm">
      <div className="flex items-center gap-2 text-[13px] font-medium text-charcoal">
        <Sparkles className="size-4 text-electric-indigo" /> Ready to build this plan?
      </div>
      {decisions.length > 0 && (
        <div className="mt-3 space-y-3">
          <p className="text-[12.5px] text-bark-grey">A few choices first — pick one, or type your own:</p>
          {decisions.map((d, i) => (
            <div key={i}>
              <p className="text-[12.5px] font-medium text-charcoal">{d.q}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {d.options.map((opt) => {
                  const on = !othering[i] && answers[i] === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => onPick(i, opt)}
                      className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${on ? "border-electric-indigo bg-electric-indigo text-white" : "border-line-strong bg-paper-white text-bark-grey hover:border-charcoal hover:text-charcoal"}`}
                    >
                      {opt}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => onOther(i)}
                  className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${othering[i] ? "border-electric-indigo bg-electric-indigo text-white" : "border-line-strong bg-paper-white text-bark-grey hover:border-charcoal hover:text-charcoal"}`}
                >
                  Other…
                </button>
              </div>
              {othering[i] && (
                <input
                  autoFocus
                  value={answers[i] ?? ""}
                  onChange={(e) => onOtherText(i, e.target.value)}
                  placeholder="Type your answer…"
                  className="mt-1.5 w-full rounded-lg border border-line-strong bg-paper-white px-3 py-1.5 text-[13px] text-charcoal outline-none focus:border-electric-indigo"
                />
              )}
            </div>
          ))}
        </div>
      )}
      <Button className="mt-3.5 gap-1.5" size="sm" onClick={onExecute} disabled={disabled}>
        <Play className="size-3.5" /> Execute plan
      </Button>
    </div>
  );
}
