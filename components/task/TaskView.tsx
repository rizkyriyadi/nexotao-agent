"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Ban, GitBranch, Loader2, PanelRight, Play, Plus, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Composer, type RunMode } from "./Composer";
import { Transcript, STATUS_LABEL, statusDot, TOOL_LABEL, type RunPhase } from "./transcript";
import { useRunStream } from "./use-run-stream";
import { WorkspaceDock } from "../files/WorkspaceDock";
import { useWorkspace } from "../files/use-workspace";
import { agentAvatar } from "@/lib/avatars";

type Issue = {
  id: string; ref: string; title: string; detail: string; status: string;
  runMode: RunMode; summary: string; createdAt: number; updatedAt: number;
  assigneeAgentId: string | null;
  model: string | null;
};
type Comment = { id: string; authorType: string; body: string; createdAt: number };
type Run = { id: string; status: string; startedAt: number | null; queuedAt: number | null; finishedAt: number | null };
type AgentLite = { id: string; name: string; avatar?: string | null };
type DocLite = { key: string; body?: string | null };
type ChildLite = { id: string; ref: string; title: string; status: string; assigneeAgentId: string | null };
type Detail = { issue: Issue; comments: Comment[]; runs: Run[]; agents: AgentLite[]; documents: DocLite[]; children: ChildLite[] };

type Decision = { q: string; options: string[] };

type TimelineItem =
  | { kind: "user"; text: string; ts: number; key: string }
  | { kind: "run"; runId: string; status: string; phase: RunPhase; ts: number; startedAt: number | null; live: boolean; key: string };

// Statuses where a run is genuinely executing — the only ones that earn a
// spinner, an elapsed clock, or a Cancel button. `blocked` is excluded (waiting
// on the user, not working) and so is `todo`: a merely queued task is not
// running, and dressing it up as one was the core of the "confusing" complaint.
const STREAMING = new Set(["in_progress", "running"]);

// Accepted but not yet executing. Occupies the same slot in the timeline as a
// streaming run, but presents as a quiet "queued" line with no interrupt.
const PENDING = new Set(["todo", "queued", "waiting"]);

// Anything not settled — used only to decide whether the composer should say
// "your message will be queued".
const OCCUPIED = new Set([...STREAMING, ...PENDING]);

// Ledger statuses (HeartbeatStatus) that mean a run has an outcome on record.
// Anything else — queued, running, waiting — is still owed one.
const SETTLED_RUN_STATUS = new Set(["succeeded", "failed", "cancelled", "done", "error"]);

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
  const [model, setModel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [othering, setOthering] = useState<Record<number, boolean>>({});
  const [dock, setDock] = useState(true);
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const modeTouched = useRef(false);
  const modelTouched = useRef(false);

  // Whether the workspace is docked is a workspace-wide preference, not a
  // per-task one: hiding it on one task and finding it back on the next reads
  // as the panel ignoring you.
  useEffect(() => { setDock(localStorage.getItem("nexotao.dock") !== "closed"); }, []);
  const toggleDock = useCallback(() => {
    setDock((open) => {
      localStorage.setItem("nexotao.dock", open ? "closed" : "open");
      return !open;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/issues/${id}`);
      if (r.status === 404) { setNotFound(true); return; }
      const d = await r.json();
      if (d?.issue) {
        setDetail({ issue: d.issue, comments: d.comments ?? [], runs: d.runs ?? [], agents: d.agents ?? [], documents: d.documents ?? [], children: d.children ?? [] });
        if (!modeTouched.current) setMode((d.issue.runMode as RunMode) ?? "agent");
        // Poll-driven, so a stale response must never overwrite a choice the
        // user just made — the same guard the mode selector uses.
        if (!modelTouched.current) setModel((d.issue.model as string | null) ?? null);
      }
    } catch { /* keep last */ }
  }, [id]);

  useEffect(() => {
    load();
    poller.current = setInterval(load, 2500);
    return () => { if (poller.current) clearInterval(poller.current); };
  }, [load]);

  const issue = detail?.issue;
  const streaming = issue ? STREAMING.has(issue.status) : false;
  const pending = issue ? PENDING.has(issue.status) : false;
  const occupied = issue ? OCCUPIED.has(issue.status) : false;

  // The dock polls only while a run is streaming — that is the one thing that
  // changes these files without the user touching anything.
  const workspace = useWorkspace({ live: streaming });

  const avatar = useMemo(() => {
    const assignee = detail?.agents.find((a) => a.id === issue?.assigneeAgentId);
    return agentAvatar(assignee?.avatar ?? null);
  }, [detail, issue]);

  // keep the view pinned to the latest activity while a run streams
  useEffect(() => {
    if (streaming && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [detail, streaming]);

  const postMessage = useCallback(async (text: string, m: RunMode) => {
    const r = await fetch(`/api/issues/${id}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text, mode: m, model }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Couldn't send"); }
    await load();
  }, [id, load, model]);

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
  // Only a streaming run is cancellable. A queued one has nothing to interrupt.
  const liveRunId = streaming ? newestRunId : null;
  const items: TimelineItem[] = [
    { kind: "user" as const, text: issue.detail || issue.title, ts: issue.createdAt, key: "goal" },
    ...detail!.comments.filter((c) => c.authorType === "user").map((c) => ({ kind: "user" as const, text: c.body, ts: c.createdAt, key: `c-${c.id}` })),
    ...runs.map((run) => {
      const newest = run.id === newestRunId;
      // A run row is only unsettled while its own status is still `running` AND
      // it is the newest row AND the issue agrees work is outstanding. Anything
      // else — a finished run, a superseded one, a cancelled issue — settles at
      // once, so no spinner can outlive the work it describes.
      // A run is unsettled while the ledger has not recorded an outcome for it
      // AND it is the newest row. Checking for `running` alone was wrong: a
      // queued/waiting run has no outcome yet either, and settling it made a
      // task that had not started announce that it had "Ended".
      const open = !SETTLED_RUN_STATUS.has(run.status) && newest;
      const phase: RunPhase = open && streaming ? "running" : open ? "queued" : "settled";
      return {
        kind: "run" as const, runId: run.id, status: run.status, phase,
        ts: run.startedAt ?? run.queuedAt ?? 0, startedAt: run.startedAt,
        live: newest && streaming, key: `r-${run.id}`,
      };
    }),
  ].sort((a, b) => a.ts - b.ts);

  const planDoc = detail!.documents.find((d) => d.key === "plan");
  const decisions = parseDecisions(planDoc?.body);
  // Offer plan execution while the task is still in Plan mode and idle. Executing
  // reopens it in Agent mode, which flips runMode and hides this panel.
  const showPlanActions = Boolean(planDoc) && issue.runMode === "plan" && !occupied;

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
    <div className="flex h-full min-w-0 flex-1">
    <div className="flex h-full min-w-0 flex-1 flex-col bg-gradient-to-b from-mist-lavender/40 via-canvas to-warm-bone">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line/70 bg-paper-white/70 px-5 backdrop-blur">
        <button onClick={() => router.push("/board")} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-pebble transition-colors hover:bg-veil hover:text-charcoal" title="Back to control panel">
          <ArrowLeft className="size-4" />
        </button>
        <img src={avatar} alt="Hutao" className="size-8 shrink-0 rounded-xl object-cover ring-1 ring-line" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14.5px] font-medium text-charcoal">{issue.title}</h1>
          <p className="font-mono text-[10.5px] text-pebble">{issue.ref} · {issue.runMode}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-bark-grey">
          {/* Only a genuinely streaming run spins. Queued shows a still dot. */}
          {streaming && <Loader2 className="size-3.5 animate-spin text-electric-indigo" />}
          <span className={`size-[6px] rounded-full ${statusDot(issue.status)}`} /> {STATUS_LABEL[issue.status] ?? issue.status}
        </span>
        {liveRunId && (
          <Button variant="outline" size="sm" className="gap-1.5 rounded-lg border-alarm-red/30 text-alarm-red hover:bg-alarm-red/[0.06]" onClick={() => cancel(liveRunId)} disabled={cancelling}>
            {cancelling ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />} Cancel
          </Button>
        )}
        <Button variant="outline" size="sm" className="gap-1.5 rounded-lg" onClick={() => router.push("/board")}><Plus className="size-3.5" /> New task</Button>
        {!dock && (
          <button
            onClick={toggleDock}
            title="Show the workspace"
            aria-label="Show the workspace panel"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-pebble transition-colors hover:bg-veil hover:text-charcoal"
          >
            <PanelRight className="size-4" strokeWidth={1.8} />
          </button>
        )}
      </header>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-6 px-6 py-8">
          {items.map((item) => item.kind === "user"
            ? <UserBubble key={item.key} text={item.text} />
            : (
              <RunSection
                key={item.key}
                runId={item.runId}
                status={item.status}
                phase={item.phase}
                startedAt={item.startedAt}
                live={item.live}
                avatar={avatar}
                onStop={item.live ? () => cancel(item.runId) : undefined}
                stopping={cancelling}
              />
            ))}

          {detail!.children.length > 0 && (
            <SubTasks tasks={detail!.children} agents={detail!.agents} onOpen={(childId) => router.push(`/board/${childId}`)} />
          )}

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
            model={model}
            onModelChange={(next) => { modelTouched.current = true; setModel(next); }}
            onSubmit={send}
            disabled={sending}
            mentionPaths={workspace.paths}
            placeholder={occupied ? "Queue a follow-up — Hutao picks it up next…" : "Reply to continue this task…"}
            hint={streaming ? "A run is in progress — your message will be queued."
              : pending ? "This task is queued — your message will be picked up with it."
              : "Sending a message reopens this task and wakes Hutao."}
          />
        </div>
      </div>
    </div>

    {dock && (
      <WorkspaceDock
        root={workspace.root}
        tree={workspace.tree}
        truncated={workspace.truncated}
        notice={workspace.notice}
        loading={workspace.loading}
        error={workspace.error}
        onReload={workspace.reload}
        onClose={toggleDock}
      />
    )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-3xl rounded-br-lg bg-electric-indigo px-4 py-2.5 text-[14px] leading-relaxed text-on-indigo shadow-sm">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function RunSection({
  runId, status, phase, startedAt, live, avatar, onStop, stopping,
}: {
  runId: string; status: string; phase: RunPhase; startedAt: number | null;
  live: boolean; avatar: string; onStop?: () => void; stopping?: boolean;
}) {
  const { log, approval, terminal } = useRunStream(runId, { live });
  const approve = useCallback(async (decision: "allow" | "deny") => {
    if (!approval) return;
    await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: approval.runId, id: approval.id, decision }) }).catch(() => {});
  }, [approval]);

  // The stream's own terminal frame settles the section immediately, without
  // waiting for the next poll of the issue status — a cancel must land at once.
  const effectivePhase: RunPhase = terminal ? "settled" : phase;

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
        <Transcript
          log={log}
          phase={effectivePhase}
          status={status}
          startedAt={startedAt}
          onStop={effectivePhase === "running" ? onStop : undefined}
          stopping={stopping}
        />
      </div>
    </div>
  );
}

/** Every sub-task this one was split into, with live status. Answers "what am I
 *  actually waiting for?" — before this, delegated work was invisible here and
 *  the parent just sat there looking stalled. */
function SubTasks({
  tasks, agents, onOpen,
}: {
  tasks: ChildLite[]; agents: AgentLite[]; onOpen: (id: string) => void;
}) {
  const nameFor = (agentId: string | null) => agents.find((a) => a.id === agentId)?.name ?? null;
  const outstanding = tasks.filter((c) => !["done", "cancelled"].includes(c.status)).length;
  return (
    <div className="ml-11 rounded-3xl border border-line bg-paper-white/80 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-bark-grey" />
        <p className="text-[13px] font-medium text-charcoal">Sub-tasks</p>
        <span className="rounded-md bg-veil px-1.5 py-px font-mono text-[10.5px] text-bark-grey">
          {outstanding > 0 ? `${outstanding} of ${tasks.length} open` : `${tasks.length} done`}
        </span>
      </div>
      <div className="mt-2 space-y-0.5">
        {tasks.map((child) => {
          const who = nameFor(child.assigneeAgentId);
          return (
            <button
              key={child.id}
              type="button"
              onClick={() => onOpen(child.id)}
              className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-veil"
            >
              <span className={`size-[6px] shrink-0 rounded-full ${statusDot(child.status)}`} />
              <span className="shrink-0 font-mono text-[11px] text-electric-indigo">{child.ref}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal" title={child.title}>{child.title}</span>
              {who && <span className="shrink-0 text-[11px] text-pebble">{who}</span>}
              <span className="shrink-0 font-mono text-[10.5px] text-bark-grey">{STATUS_LABEL[child.status] ?? child.status}</span>
            </button>
          );
        })}
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
                      className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${on ? "border-electric-indigo bg-electric-indigo text-on-indigo" : "border-line-strong bg-paper-white text-bark-grey hover:border-charcoal hover:text-charcoal"}`}
                    >
                      {opt}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => onOther(i)}
                  className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${othering[i] ? "border-electric-indigo bg-electric-indigo text-on-indigo" : "border-line-strong bg-paper-white text-bark-grey hover:border-charcoal hover:text-charcoal"}`}
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
