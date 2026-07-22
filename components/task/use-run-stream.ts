"use client";

import { useEffect, useState } from "react";
import type { LogItem } from "./transcript";

export type Approval = { runId: string; id: string; name: string; input: any } | null;

function tgt(name: string, input: any) {
  if (name === "bash") return input?.command ?? "";
  if (name === "grep") return input?.pattern ?? "";
  if (name === "web_search") return input?.query ?? "";
  if (name === "web_fetch") return input?.url ?? "";
  return input?.path ?? "";
}

/**
 * Stream a single run's transcript (replay + live tail) over SSE. For a finished
 * run the endpoint replays the saved event log and closes; for a live run it
 * keeps tailing. Returns the accumulated log, any pending approval, and whether
 * the run has reached a terminal event.
 */
export function useRunStream(runId: string | null | undefined, opts?: { live?: boolean }): {
  log: LogItem[];
  approval: Approval;
  terminal: boolean;
} {
  const [log, setLog] = useState<LogItem[]>([]);
  const [approval, setApproval] = useState<Approval>(null);
  const [terminal, setTerminal] = useState(false);
  const live = opts?.live ?? true;

  useEffect(() => {
    setLog([]);
    setApproval(null);
    setTerminal(false);
    if (!runId) return;

    const ac = new AbortController();
    let cursor = 0;
    let done = false;
    let attempts = 0;

    const append = (text: string) => setLog((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "text") { const copy = [...prev]; copy[copy.length - 1] = { kind: "text", text: last.text + text }; return copy; }
      return [...prev, { kind: "text", text }];
    });

    const addEvent = (raw: any): boolean => {
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
      } else if (type === "waiting")
        setLog((prev) => [...prev, { kind: "event", tone: "neutral", label: "Waiting", detail: String(e.reason ?? "Approval required") }]);
      else if (["success", "failure", "cancellation", "done", "error", "cancelled"].includes(type)) {
        const detail = String(e.error ?? e.reason ?? "");
        setLog((prev) => [...prev, {
          kind: "event",
          tone: type === "success" || type === "done" ? "success" : "error",
          label: type === "success" || type === "done" ? "Done" : type === "cancellation" || type === "cancelled" ? "Cancelled" : "Failed",
          detail,
        }]);
        return true;
      }
      return false;
    };

    (async () => {
      while (!ac.signal.aborted && !done && attempts < 6) {
        try {
          const res = await fetch(`/api/run/stream?runId=${runId}&cursor=${cursor}`, { signal: ac.signal, headers: cursor ? { "Last-Event-ID": String(cursor) } : {} });
          if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!done) {
            const { done: readerDone, value } = await reader.read();
            if (readerDone) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
              if (!dataLine) continue;
              if (addEvent(JSON.parse(dataLine.slice(5).trim()))) { done = true; break; }
            }
          }
          if (done) break;
          // A finished run closes the stream with no terminal event once fully
          // replayed; stop tailing unless the caller wants to keep polling.
          if (!live) break;
          attempts += 1;
        } catch {
          if (ac.signal.aborted) return;
          attempts += 1;
        }
        if (attempts < 6) await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempts, 4_000)));
      }
      if (done) setTerminal(true);
    })();

    return () => ac.abort();
  }, [runId, live]);

  return { log, approval, terminal };
}
