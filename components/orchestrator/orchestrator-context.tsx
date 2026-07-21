"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; target: string; status: "running" | "done" | "error"; display?: string };

export type Thread = {
  id: string;
  name: string;
  scope: string;
  status: "running" | "done" | "error";
  dependsOn?: string[];
  log: LogItem[];
};

export type RunSummary = { id: string; kind: string; title: string; status: string; createdAt: number; updatedAt: number };

type Ctx = {
  started: boolean;
  running: boolean;
  task: string;
  threads: Thread[];
  selected: string;
  runs: RunSummary[];
  setSelected: (id: string) => void;
  start: (task: string) => void;
  openRun: (id: string) => void;
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
  if (name === "spawn_agents") return (input?.agents ?? []).map((a: any) => a.name).join(", ");
  return input?.path ?? "";
}

const LEAD = (): Thread => ({ id: "lead", name: "Lead", scope: "Plan & integrate", status: "running", log: [] });

export function OrchestratorProvider({ children }: { children: ReactNode }) {
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [task, setTask] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("lead");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const threadsRef = useRef<Thread[]>([]);
  const connected = useRef(false);
  const startedByMe = useRef(false);
  useEffect(() => { threadsRef.current = threads; }, [threads]);

  const refreshRuns = useCallback(() => {
    fetch("/api/runs?kind=orchestrator").then((r) => r.json()).then((d) => setRuns(d.runs ?? [])).catch(() => {});
  }, []);

  const upd = (id: string, fn: (t: Thread) => Thread) => setThreads((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  const appendText = (id: string, delta: string) =>
    upd(id, (t) => {
      const last = t.log[t.log.length - 1];
      if (last && last.kind === "text") {
        const log = [...t.log];
        log[log.length - 1] = { kind: "text", text: last.text + delta };
        return { ...t, log };
      }
      return { ...t, log: [...t.log, { kind: "text", text: delta }] };
    });

  // consume a reconnectable stream (replay + live tail) and rebuild the tree
  const consume = useCallback(
    async (query: string) => {
      if (connected.current) return;
      connected.current = true;
      setRunning(true);
      try {
        const res = await fetch(`/api/run/stream?${query}`);
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let ended = false;
        while (!ended) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const p of parts) {
            const line = p.trim();
            if (!line.startsWith("data:")) continue;
            const e = JSON.parse(line.slice(5).trim());
            if (e.type === "idle" || e.type === "done") { ended = true; break; }
            if (e.type === "error") { if (e.error) toast.error(String(e.error)); ended = true; break; }
            const th = e.thread ?? "lead";
            switch (e.type) {
              case "thread_created":
                setThreads((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, { id: e.id, name: e.id, scope: e.scope, status: "running", dependsOn: e.dependsOn, log: [] }]));
                break;
              case "thread_status":
                upd(e.id, (t) => ({ ...t, status: e.status }));
                break;
              case "text":
                appendText(th, e.text);
                break;
              case "tool_use":
                upd(th, (t) => ({ ...t, log: [...t.log, { kind: "tool", id: e.id, name: e.name, target: tgt(e.name, e.input), status: "running" }] }));
                break;
              case "tool_result":
                upd(th, (t) => ({ ...t, log: t.log.map((it) => (it.kind === "tool" && it.id === e.id ? { ...it, status: e.ok ? "done" : "error", display: e.display } : it)) }));
                break;
            }
          }
        }
      } catch (err: any) {
        toast.error(String(err?.message ?? err));
      } finally {
        connected.current = false;
        setThreads((prev) => prev.map((x) => (x.status === "running" ? { ...x, status: "done" } : x)));
        setRunning(false);
        refreshRuns();
        if (startedByMe.current) {
          startedByMe.current = false;
          for (const th of threadsRef.current.filter((x) => x.id !== "lead")) {
            const lastText = [...th.log].reverse().find((l) => l.kind === "text") as { kind: "text"; text: string } | undefined;
            fetch("/api/agent-runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: th.name, task, summary: (lastText?.text || "Worked on the task").slice(0, 400), ok: th.status !== "error" }) }).catch(() => {});
          }
        }
      }
    },
    [refreshRuns, task],
  );

  const start = useCallback(
    async (raw: string) => {
      const t = raw.trim();
      if (!t || running) return;
      setTask(t);
      setStarted(true);
      setSelected("lead");
      setThreads([LEAD()]);
      startedByMe.current = true;
      try {
        const post = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: t }], multi: true }) });
        if (!post.ok) {
          const err = await post.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error || "Request failed");
        }
        const { runId } = await post.json();
        window.history.replaceState({}, "", `/orchestrator?run=${runId}`);
        await consume(`runId=${runId}`);
      } catch (err: any) {
        const m = String(err?.message ?? err);
        toast.error(m.includes("onboarding") ? "Finish onboarding to connect Nexotao." : m);
        setRunning(false);
      }
    },
    [running, consume],
  );

  // open an existing run (running → live tail; finished → replay from disk)
  const openRun = useCallback(
    (id: string) => {
      if (connected.current) return;
      window.history.replaceState({}, "", `/orchestrator?run=${id}`);
      const summary = runs.find((r) => r.id === id);
      setTask(summary?.title ?? "Run");
      setStarted(true);
      setSelected("lead");
      setThreads([LEAD()]);
      consume(`runId=${id}`);
    },
    [runs, consume],
  );

  const newRun = useCallback(() => {
    window.history.replaceState({}, "", "/orchestrator");
    setStarted(false);
    setRunning(false);
    setThreads([]);
    setTask("");
    refreshRuns();
  }, [refreshRuns]);

  // boot: load run list, and reconnect to ?run= if present
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    refreshRuns();
    const id = new URLSearchParams(window.location.search).get("run");
    if (id) {
      setStarted(true);
      setSelected("lead");
      setThreads([LEAD()]);
      consume(`runId=${id}`);
    }
  }, [consume, refreshRuns]);

  return (
    <OrchCtx.Provider value={{ started, running, task, threads, selected, runs, setSelected, start, openRun, newRun }}>{children}</OrchCtx.Provider>
  );
}
