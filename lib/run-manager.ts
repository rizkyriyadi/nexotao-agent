import { saveRunRecord } from "./store";
import { redactValue } from "./redact";

export type RunEvent =
  | { type: "run"; runId: string }
  | { type: "status"; status: string }
  | { type: "text"; text: string; thread?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; thread?: string }
  | { type: "tool_use"; id: string; name: string; input: any; thread?: string }
  | { type: "approval"; id: string; name: string; input: any; thread?: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; display?: string; kind?: string; file?: string; content?: string; output: string; thread?: string }
  | { type: "thread_created"; id: string; scope: string; dependsOn?: string[] }
  | { type: "thread_status"; id: string; status: "running" | "done" | "error" }
  | { type: "done" }
  | { type: "cancelled"; reason: string }
  | { type: "error"; error: string };

/** A durable, backend-owned run. Keeps a full event log so a client that
 * refreshes / changes tab can reconnect and replay + tail live. Runs to
 * completion regardless of whether anyone is connected. */
export type RunMeta = { kind: "chat" | "orchestrator"; title: string; projectId: string };

export class Run {
  id: string;
  sessionId?: string;
  meta: RunMeta;
  createdAt = Date.now();
  events: RunEvent[] = [];
  finished = false;
  errored = false;
  cancelled = false;
  finishedAt = 0;
  private controller = new AbortController();
  private subs = new Set<(e: RunEvent) => void>();
  private approvals = new Map<string, (d: "allow" | "deny") => void>();
  private lastSave = 0;

  constructor(id: string, sessionId?: string, meta?: Partial<RunMeta>) {
    this.id = id;
    this.sessionId = sessionId;
    this.meta = { kind: meta?.kind ?? "chat", title: meta?.title ?? "Run", projectId: meta?.projectId ?? "" };
  }

  /** Mirror the event log to disk so a run survives navigation, GC and even a
   * server restart, and can be reopened and replayed from the Runs list. */
  private persist(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSave < 1000) return;
    this.lastSave = now;
    saveRunRecord({
      id: this.id,
      projectId: this.meta.projectId,
      kind: this.meta.kind,
      title: this.meta.title,
      status: this.finished ? (this.cancelled ? "cancelled" : this.errored ? "error" : "done") : "running",
      createdAt: this.createdAt,
      updatedAt: now,
      events: coalesceText(this.events),
    }).catch(() => {});
  }

  push(e: RunEvent) {
    if (this.finished) return;
    e = redactValue(e);
    this.events.push(e);
    for (const s of this.subs) {
      try { s(e); } catch { /* ignore a dead subscriber */ }
    }
    if (e.type === "done" || e.type === "error" || e.type === "cancelled") {
      this.finished = true;
      this.errored = e.type === "error";
      this.cancelled = e.type === "cancelled";
      this.finishedAt = Date.now();
      this.persist(true);
    } else {
      this.persist(this.events.length <= 1); // create the record immediately
    }
  }

  /** Atomically replay the log to fn, then (if still running) tail live. */
  subscribe(fn: (e: RunEvent) => void): () => void {
    for (const e of this.events) fn(e);
    if (this.finished) return () => {};
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get signal() { return this.controller.signal; }

  cancel(reason = "Cancelled by user") {
    if (this.finished) return false;
    this.controller.abort(new Error(reason));
    for (const resolve of this.approvals.values()) resolve("deny");
    this.approvals.clear();
    this.push({ type: "cancelled", reason });
    return true;
  }

  awaitApproval(id: string): Promise<"allow" | "deny"> {
    return new Promise((res) => this.approvals.set(id, res));
  }
  resolveApproval(id: string, decision: "allow" | "deny") {
    const r = this.approvals.get(id);
    if (r) { r(decision); this.approvals.delete(id); }
  }
}

/** Merge consecutive text deltas of the same thread so the on-disk log stays
 * small (a run can emit thousands of one-token text events). */
function coalesceText(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "text" && last && last.type === "text" && last.thread === e.thread) {
      out[out.length - 1] = { ...last, text: last.text + e.text };
    } else {
      out.push(e);
    }
  }
  return out;
}

const runs = new Map<string, Run>();
const activeBySession = new Map<string, string>();

function gc() {
  const now = Date.now();
  for (const [id, r] of runs) {
    if (r.finished && now - r.finishedAt > 15 * 60_000) {
      runs.delete(id);
      if (r.sessionId && activeBySession.get(r.sessionId) === id) activeBySession.delete(r.sessionId);
    }
  }
}

export function createRun(id: string, sessionId?: string, meta?: Partial<RunMeta>) {
  gc();
  const r = new Run(id, sessionId, meta);
  runs.set(id, r);
  if (sessionId) activeBySession.set(sessionId, id);
  return r;
}
export function getRun(id: string) {
  return runs.get(id);
}
export function getActiveRun(sessionId: string) {
  const id = activeBySession.get(sessionId);
  return id ? runs.get(id) : undefined;
}
