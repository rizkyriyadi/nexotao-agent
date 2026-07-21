"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; target: string; status: "running" | "done" | "error"; display?: string };

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
  recent: { id: string; title: string; status: string; updatedAt: number }[];
  approval: Approval;
  approve: (decision: "allow" | "deny") => void;
  setSelected: (id: string) => void;
  start: (goal: string) => void;
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
  const [recent, setRecent] = useState<{ id: string; title: string; status: string; updatedAt: number }[]>([]);
  const [approval, setApproval] = useState<Approval>(null);

  const rootId = useRef<string | null>(null);
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
    try {
      const res = await fetch(`/api/run/stream?runId=${runId}`, { signal: ac.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const append = (t: string) => setLog((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === "text") { const c = [...prev]; c[c.length - 1] = { kind: "text", text: last.text + t }; return c; }
        return [...prev, { kind: "text", text: t }];
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() || "";
        for (const p of parts) {
          const line = p.trim(); if (!line.startsWith("data:")) continue;
          const e = JSON.parse(line.slice(5).trim());
          if (e.type === "idle" || e.type === "done" || e.type === "error") { streamingRunId.current = null; return; }
          if (e.type === "text") append(e.text);
          else if (e.type === "approval") setApproval({ runId, id: e.id, name: e.name, input: e.input });
          else if (e.type === "tool_use") setLog((prev) => [...prev, { kind: "tool", id: e.id, name: e.name, target: tgt(e.name, e.input), status: "running" }]);
          else if (e.type === "tool_result") setLog((prev) => prev.map((it) => (it.kind === "tool" && it.id === e.id ? { ...it, status: e.ok ? "done" : "error", display: e.display } : it)));
        }
      }
    } catch { /* aborted or ended */ }
    finally { if (streamingRunId.current === runId) streamingRunId.current = null; }
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
      const roots = (d.issues ?? []).filter((i: any) => !i.parentId).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
      setRecent(roots.map((r: any) => ({ id: r.id, title: r.title, status: r.status, updatedAt: r.updatedAt })));
    }).catch(() => {});
  }, []);

  const enterRun = useCallback((rid: string, goal: string) => {
    rootId.current = rid;
    setGoalText(goal);
    setStarted(true);
    setSelected(rid);
    setNodes([]);
    setLog([]);
    streamingRunId.current = null;
    window.history.replaceState({}, "", `/orchestrator?goal=${rid}`);
    startPolling();
  }, [startPolling]);

  const start = useCallback(async (raw: string) => {
    const goal = raw.trim();
    if (!goal || running) return;
    try {
      const r = await fetch("/api/issues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Request failed"); }
      const { root } = await r.json();
      enterRun(root.id, goal);
    } catch (err: any) {
      toast.error(String(err?.message ?? err).includes("onboarding") ? "Finish onboarding to connect Nexotao." : String(err?.message ?? err));
    }
  }, [running, enterRun]);

  const openRun = useCallback((rid: string) => {
    const g = recent.find((x) => x.id === rid);
    enterRun(rid, g?.title ?? "Run");
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
    window.history.replaceState({}, "", "/orchestrator");
    refreshRecent();
  }, [refreshRecent]);

  // select the root once the tree first loads
  useEffect(() => {
    if (started && !selected && nodes.length) setSelected(rootId.current);
  }, [started, selected, nodes]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    refreshRecent();
    const gid = new URLSearchParams(window.location.search).get("goal");
    if (gid) enterRun(gid, "Run");
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
