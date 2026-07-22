"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

export type Item =
  | { kind: "user"; text: string; display?: string; files?: string[] }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; input: any; status: "running" | "done" | "error"; display?: string; output?: string };

type Approval = { runId: string; id: string; name: string; input: any } | null;

/** Paperclip-style run mode picked in the composer. Mirrors lib/execution-policy. */
export type AgentMode = "agent" | "plan" | "ask";

type Ctx = {
  items: Item[];
  streaming: boolean;
  approval: Approval;
  terminal: string[];
  diff: { file: string; content: string } | null;
  mode: AgentMode;
  setMode: (m: AgentMode) => void;
  send: (text: string, meta?: { display?: string; files?: string[] }) => void;
  approve: (decision: "allow" | "deny") => void;
  cancel: () => void;
};

const WorkspaceCtx = createContext<Ctx | null>(null);
export const useWorkspace = () => {
  const c = useContext(WorkspaceCtx);
  if (!c) throw new Error("useWorkspace outside provider");
  return c;
};

export function target(name: string, input: any) {
  if (name === "bash") return input?.command ?? "";
  if (name === "grep") return input?.pattern ?? "";
  if (name === "web_search") return input?.query ?? "";
  if (name === "web_fetch") return input?.url ?? "";
  return input?.path ?? "";
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [approval, setApproval] = useState<Approval>(null);
  const [terminal, setTerminal] = useState<string[]>([]);
  const [diff, setDiff] = useState<{ file: string; content: string } | null>(null);
  const [mode, setMode] = useState<AgentMode>("agent");

  const runId = useRef("");
  const modeRef = useRef<AgentMode>("agent");
  modeRef.current = mode;
  const sessionRef = useRef<string | null>(null);
  const taskRef = useRef<string | null>(null);
  const booted = useRef(false);
  const connected = useRef(false); // guards against double stream consumers

  const appendText = (delta: string) =>
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const c = [...prev];
        c[c.length - 1] = { ...last, text: last.text + delta };
        return c;
      }
      return [...prev, { kind: "assistant", text: delta, streaming: true }];
    });
  const finalizeAssistants = () => setItems((prev) => prev.map((it) => (it.kind === "assistant" ? { ...it, streaming: false } : it)));

  // apply one server event to the UI
  const applyEvent = useCallback((e: any) => {
    switch (e.type) {
      case "run":
        runId.current = e.runId;
        break;
      case "text":
        appendText(e.text);
        break;
      case "tool_use":
        finalizeAssistants();
        setItems((prev) => [...prev, { kind: "tool", id: e.id, name: e.name, input: e.input, status: "running" }]);
        if (e.name === "bash") setTerminal((t) => [...t, `$ ${e.input?.command ?? ""}`]);
        break;
      case "approval":
        setApproval({ runId: runId.current, id: e.id, name: e.name, input: e.input });
        break;
      case "tool_result":
        setItems((prev) => prev.map((it) => (it.kind === "tool" && it.id === e.id ? { ...it, status: e.ok ? "done" : "error", display: e.display, output: e.output } : it)));
        if (e.kind === "bash") setTerminal((t) => [...t, e.output, ""]);
        if (e.file && e.content != null) setDiff({ file: e.file, content: e.content });
        break;
    }
  }, []);

  // consume a reconnectable SSE stream to completion (replay + live tail)
  const consumeStream = useCallback(
    async (query: string) => {
      if (connected.current) return;
      connected.current = true;
      setStreaming(true);
      try {
        const res = await fetch(`/api/run/stream?${query}`);
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const p of parts) {
            const line = p.trim();
            if (!line.startsWith("data:")) continue;
            const e = JSON.parse(line.slice(5).trim());
            if (e.type === "idle") return;
            if (e.type === "error") { toast.error(String(e.error)); return; }
            if (e.type === "done" || e.type === "cancelled") {
              if (taskRef.current) {
                fetch("/api/tasks", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: taskRef.current, col: "review" }) }).catch(() => {});
                taskRef.current = null;
              }
              return;
            }
            applyEvent(e);
          }
        }
      } catch (err: any) {
        toast.error(String(err?.message ?? err));
      } finally {
        connected.current = false;
        finalizeAssistants();
        setStreaming(false);
        setApproval(null);
      }
    },
    [applyEvent],
  );

  const send = useCallback(
    async (raw: string, meta?: { display?: string; files?: string[] }) => {
      const text = raw.trim();
      if (!text || streaming) return;

      const history = items
        .filter((i) => i.kind === "user" || (i.kind === "assistant" && i.text))
        .map((i) => ({ role: i.kind as "user" | "assistant", content: (i as any).text }));

      // `text` (with any attached file bodies) is what the model + history see;
      // `display` is what the user sees in their bubble.
      setItems((prev) => [...prev, { kind: "user", text, display: meta?.display, files: meta?.files }]);
      setStreaming(true);
      const titleFor = meta?.display?.trim() || text;

      // ensure a session exists so the durable run can be reconnected by ?session=
      if (!sessionRef.current) {
        try {
          const r = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: titleFor }) });
          const d = await r.json();
          if (d.session?.id) {
            sessionRef.current = d.session.id;
            window.history.replaceState({}, "", `/chat?session=${d.session.id}`);
          }
        } catch { /* keep going even if persistence fails */ }
      }

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [...history, { role: "user", content: text }], multi: false, sessionId: sessionRef.current, mode: modeRef.current }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error || "Request failed");
        }
        const { runId: id } = await res.json();
        runId.current = id;
        // now tail the durable run — reconnectable by session (survives refresh)
        await consumeStream(sessionRef.current ? `session=${sessionRef.current}` : `runId=${id}`);
      } catch (err: any) {
        const m = String(err?.message ?? err);
        toast.error(m.includes("onboarding") ? "Finish onboarding to connect Nexotao." : m);
        finalizeAssistants();
        setStreaming(false);
      }
    },
    [streaming, items, consumeStream],
  );

  // seed the composer's mode from the user's configured default (agent by default)
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => { if (c?.defaultMode) setMode(c.defaultMode as AgentMode); })
      .catch(() => {});
  }, []);

  // boot: load a session from ?session= (and reconnect to any in-flight run),
  // or auto-start from ?task=
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("session");
    const task = params.get("task");
    taskRef.current = params.get("taskId");

    if (sid) {
      sessionRef.current = sid;
      (async () => {
        // 1) render saved conversation
        const saved = await fetch(`/api/sessions?id=${sid}`).then((r) => r.json()).catch(() => null);
        let loaded: Item[] = [];
        if (saved?.session?.messages) {
          loaded = saved.session.messages.map((m: any) => ({ kind: m.role, text: m.content }));
          setItems(loaded);
        }
        // 2) if a run is still in flight, drop the trailing assistant (it will be
        // rebuilt live from the run's event log) and reconnect to the stream
        const status = await fetch(`/api/run?session=${sid}`).then((r) => r.json()).catch(() => null);
        if (status?.running) {
          setItems((prev) => {
            const c = [...prev];
            while (c.length && c[c.length - 1].kind === "assistant") c.pop();
            return c;
          });
          consumeStream(`session=${sid}`);
        }
      })();
    } else if (task) {
      window.history.replaceState({}, "", window.location.pathname);
      send(task);
    }
  }, [send, consumeStream]);

  const approve = useCallback(async (decision: "allow" | "deny") => {
    const a = approval;
    setApproval(null);
    if (!a) return;
    await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: a.runId, id: a.id, decision }) }).catch(() => {});
  }, [approval]);

  const cancel = useCallback(async () => {
    if (!runId.current) return;
    await fetch("/api/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: runId.current }) }).catch(() => {});
  }, []);

  return <WorkspaceCtx.Provider value={{ items, streaming, approval, terminal, diff, mode, setMode, send, approve, cancel }}>{children}</WorkspaceCtx.Provider>;
}
