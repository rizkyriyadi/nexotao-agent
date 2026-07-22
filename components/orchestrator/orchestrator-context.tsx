"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { summarizeRuns, type RunSummary } from "@/lib/runs";
import type { RunMode } from "./Composer";

export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; target: string; status: "running" | "done" | "error"; display?: string; input?: unknown; output?: string }
  | { kind: "event"; tone: "neutral" | "success" | "error"; label: string; detail?: string };

export type IssueNode = {
  id: string;
  ref: string;
  title: string;
  agentName: string;
  role: "lead" | "worker";
  status: string;
  stage: string;
  blockedBy: string[];
  runId: string | null;
  parentId: string | null;
  summary: string;
};

type Approval = { runId: string; id: string; name: string; input: any } | null;

type Ctx = {
  started: boolean;
  running: boolean;
  goalText: string;
  nodes: IssueNode[];
  agents: { id: string; name: string; role: string }[];
  selected: string | null;
  log: LogItem[];
  recent: RunSummary[];
  approval: Approval;
  approve: (decision: "allow" | "deny") => void;
  setSelected: (id: string) => void;
  start: (goal: string, mode?: RunMode) => void;
  openRun: (rootId: string) => void;
  newRun: () => void;
};

const OrchCtx = createContext<Ctx | null>(null);
export const useOrch = () => {
  const c = useContext(OrchCtx);
  if (!c) throw new Error("useOrch outside provider");
  return c;
};

function tgt(name: string, input: any) {
  if (name === "bash") return input?.command ?? "";
  if (name === "grep") return input?.pattern ?? "";
  if (name === "web_search") return input?.query ?? "";
  if (name === "web_fetch") return input?.url ?? "";
  if (name === "delegate") return (input?.tasks ?? []).map((t: any) => t.assignee).join(", ");
  return input?.path ?? "";
}

export function OrchestratorProvider({ children }: { children: ReactNode }) {
  const [started, setStarted] = useState(false);
  const [goalText, setGoalText] = useState("");
  const [nodes, setNodes] = useState<IssueNode[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; role: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [log, setLog] = useState<LogItem[]>([]);
  const [recent, setRecent] = useState<RunSummary[]>([]);
  const [approval, setApproval] = useState<Approval>(null);

  const rootId = useRef<string | null>(null);
  const pendingSelect = useRef<string | null>(null);
  const poller = useRef<any>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const streamingRunId = useRef<string | null>(null);
  const booted = useRef(false);

  const running = nodes.some((n) => n.status === "in_progress" || n.status === "todo" || n.status === "blocked");

  // build the tree for the current goal from all issues
  const applyIssues = useCallback((issues: any[], ags: any[]) => {
    const rid = rootId.current;
    if (!rid) return;
    const byId = new Map(issues.map((i) => [i.id, i]));
    const nameOf = (aid: string | null) => ags.find((a) => a.id === aid)?.name ?? "?";
    const roleOf = (aid: string | null) => (ags.find((a) => a.id === aid)?.role ?? "worker") as "lead" | "worker";
    // root + its descendants
    const inTree = (i: any): boolean => {
      let cur: any = i;
      for (let g = 0; g < 8 && cur; g++) { if (cur.id === rid) return true; cur = cur.parentId ? byId.get(cur.parentId) : null; }
      return false;
    };
    const ns: IssueNode[] = issues.filter(inTree).map((i) => ({
      id: i.id, ref: i.ref, title: i.title, agentName: nameOf(i.assigneeAgentId), role: roleOf(i.assigneeAgentId),
      status: i.status, stage: i.stage, blockedBy: i.blockedBy ?? [], runId: i.runId ?? null, parentId: i.parentId, summary: i.summary ?? "",
    }));
    setNodes(ns);
    setAgents(ags.map((a) => ({ id: a.id, name: a.name, role: a.role })));
  }, []);

  const poll = useCallback(async () => {
    try {
      const d = await fetch("/api/issues").then((r) => r.json());
      applyIssues(d.issues ?? [], d.agents ?? []);
    } catch { /* keep last */ }
  }, [applyIssues]);

  const startPolling = useCallback(() => {
    if (poller.current) clearInterval(poller.current);
    poll();
    poller.current = setInterval(poll, 2000);
  }, [poll]);

  // stream the selected issue's run transcript (replay + live tail)
  const streamRun = useCallback(async (runId: string) => {
    if (streamingRunId.current === runId) return;
    streamAbort.current?.abort();
    const ac = new AbortController();
    streamAbort.current = ac;
    streamingRunId.current = runId;
    setLog([]);
    let cursor = 0;
    let terminal = false;
    let attempts = 0;
    const append = (text: string) => setLog((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "text") { const copy = [...prev]; copy[copy.length - 1] = { kind: "text", text: last.text + text }; return copy; }
      return [...prev, { kind: "text", text }];
    });
    const addEvent = (raw: any) => {
      const e = raw.payload !== undefined ? { type: raw.type, ...raw.payload } : raw;
      if (Number.isSafeInteger(raw.seq) && raw.seq <= cursor) return false;
      if (Number.isSafeInteger(raw.seq)) cursor = raw.seq;
      const type = e.type;
      if (type === "idle") return true;
      if (type === "reasoning_summary" || type === "output" || type === "text") append(String(e.text ?? ""));
      else if (type === "approval_wait" || type === "approval") setApproval({ runId, id: e.id, name: e.name, input: e.input });
      else if (type === "tool_call" || type === "tool_use")
        setLog((prev) => prev.some((item) => item.kind === "tool" && item.id === e.id) ? prev : [...prev, { kind: "tool", id: e.id, name: e.name, target: tgt(e.name, e.input), input: e.input, status: "running" }]);
      else if (type === "tool_result") {
        setLog((prev) => prev.map((item) => item.kind === "tool" && item.id === e.id ? { ...item, status: e.ok ? "done" : "error", display: e.display, output: e.output } : item));
        setApproval(null);
      } else if (type === "usage")
        setLog((prev) => [...prev, { kind: "event", tone: "neutral", label: "Usage", detail: `${e.inputTokens ?? 0} input · ${e.outputTokens ?? 0} output tokens` }]);
      else if (type === "waiting")
        setLog((prev) => [...prev, { kind: "event", tone: "neutral", label: "Waiting", detail: String(e.reason ?? "Approval required") }]);
      else if (["success", "failure", "cancellation", "done", "error", "cancelled"].includes(type)) {
        const detail = String(e.error ?? e.reason ?? "");
        setLog((prev) => [...prev, { kind: "event", tone: type === "success" || type === "done" ? "success" : "error", label: type === "success" || type === "done" ? "Run succeeded" : type === "cancellation" || type === "cancelled" ? "Run cancelled" : "Run failed", detail }]);
        if (type === "failure" || type === "error") toast.error(detail || "Run failed");
        return true;
      }
      return false;
    };
    try {
      while (!ac.signal.aborted && !terminal && attempts < 6) {
        try {
          const res = await fetch(`/api/run/stream?runId=${runId}&cursor=${cursor}`, { signal: ac.signal, headers: cursor ? { "Last-Event-ID": String(cursor) } : {} });
          if (!res.ok) throw new Error(`Stream failed (${res.status})`);
          if (!res.body) throw new Error("Stream has no body");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!terminal) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
              if (!dataLine) continue;
              if (addEvent(JSON.parse(dataLine.slice(5).trim()))) { terminal = true; break; }
            }
          }
          if (terminal) break;
          attempts += 1;
        } catch {
          if (ac.signal.aborted) return;
          attempts += 1;
        }
        if (attempts < 6) await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempts, 4_000)));
      }
    } finally { if (streamingRunId.current === runId) streamingRunId.current = null; }
  }, []);

  const select = useCallback((id: string) => {
    setSelected(id);
    const node = nodes.find((n) => n.id === id);
    if (node?.runId) streamRun(node.runId);
    else { streamAbort.current?.abort(); streamingRunId.current = null; setLog([]); }
  }, [nodes, streamRun]);

  // re-stream when the selected node gains a runId (it just started)
  useEffect(() => {
    if (!selected) return;
    const node = nodes.find((n) => n.id === selected);
    if (node?.runId && streamingRunId.current !== node.runId) streamRun(node.runId);
  }, [nodes, selected, streamRun]);

  const refreshRecent = useCallback(() => {
    fetch("/api/issues").then((r) => r.json()).then((d) => {
      setRecent(summarizeRuns(d.issues ?? []));
    }).catch(() => {});
  }, []);

  const enterRun = useCallback((rid: string, goal: string, nodeId?: string) => {
    rootId.current = rid;
    pendingSelect.current = nodeId ?? rid;
    setGoalText(goal);
    setStarted(true);
    setSelected(pendingSelect.current);
    setNodes([]);
    setLog([]);
    streamingRunId.current = null;
    window.history.replaceState({}, "", `/board?goal=${rid}`);
    startPolling();
  }, [startPolling]);

  const start = useCallback(async (raw: string, mode: RunMode = "agent") => {
    const goal = raw.trim();
    if (!goal || running) return;
    try {
      const r = await fetch("/api/issues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal, mode }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Request failed"); }
      const { root } = await r.json();
      enterRun(root.id, goal);
    } catch (err: any) {
      toast.error(String(err?.message ?? err).includes("onboarding") ? "Finish onboarding to connect Nexotao." : String(err?.message ?? err));
    }
  }, [running, enterRun]);

  const openRun = useCallback((rid: string) => {
    const g = recent.find((x) => x.rootId === rid);
    // jump straight to the node holding the live transcript when one is running
    enterRun(rid, g?.title ?? "Run", g?.liveNodeId);
    poll();
  }, [recent, enterRun, poll]);

  const newRun = useCallback(() => {
    if (poller.current) clearInterval(poller.current);
    streamAbort.current?.abort();
    rootId.current = null;
    setStarted(false);
    setNodes([]);
    setLog([]);
    setGoalText("");
    window.history.replaceState({}, "", "/board");
    refreshRecent();
  }, [refreshRecent]);

  // select the pending target (live node or root) once the tree first loads
  useEffect(() => {
    if (started && !selected && nodes.length) setSelected(pendingSelect.current ?? rootId.current);
  }, [started, selected, nodes]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    refreshRecent();
    const params = new URLSearchParams(window.location.search);
    const gid = params.get("goal");
    if (gid) enterRun(gid, "Run", params.get("node") ?? undefined);
    return () => { if (poller.current) clearInterval(poller.current); streamAbort.current?.abort(); };
  }, [refreshRecent, enterRun]);

  const approve = useCallback(async (decision: "allow" | "deny") => {
    const pending = approval;
    setApproval(null);
    if (!pending) return;
    await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: pending.runId, id: pending.id, decision }) }).catch(() => {});
  }, [approval]);

  return (
    <OrchCtx.Provider value={{ started, running, goalText, nodes, agents, selected, log, recent, approval, approve, setSelected: select, start, openRun, newRun }}>
      {children}
    </OrchCtx.Provider>
  );
}
