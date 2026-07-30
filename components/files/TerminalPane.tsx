"use client";

/* The shell, in the folder the panel is already showing.
 *
 * Not an emulator. There is no tty behind this (see lib/terminal.ts for why),
 * so drawing a full VT100 would be dressing up a capability we do not have —
 * the log is plain text, and the two things that would mislead a user are said
 * out loud instead: full-screen programs and password prompts will not work. */

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Square, TerminalSquare } from "lucide-react";

type Line = { seq: number; kind: "out" | "err" | "cmd" | "note"; text: string };

const HISTORY = 500;

export function TerminalPane({ rootId, rootLabel }: { rootId: string | null; rootLabel?: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const historyAt = useRef(-1);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const append = useCallback((line: Line) => {
    setLines((current) => {
      const next = [...current, line];
      return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
    });
  }, []);

  // One shell per folder: switching the panel to another root opens that
  // folder's shell, and coming back rejoins the first one with its scrollback.
  useEffect(() => {
    let cancelled = false;
    setLines([]); setSession(null); setError(null);
    fetch("/api/terminal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", rootId }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) { setError(data.error); return; }
        setSession(data.sessionId);
        setCwd(data.cwd);
      })
      .catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [rootId]);

  // Output. Reconnects on its own, resuming from the last sequence it saw, so a
  // dropped connection mid-build does not cost the user the rest of the output.
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let cursor = 0;
    let attempts = 0;
    const controller = new AbortController();

    const consume = async () => {
      while (!stopped) {
        try {
          const response = await fetch(`/api/terminal/stream?session=${session}&cursor=${cursor}`, {
            signal: controller.signal, cache: "no-store",
          });
          const reader = response.body?.getReader();
          if (!reader) throw new Error("no stream");
          attempts = 0;
          const decoder = new TextDecoder();
          let carry = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            carry += decoder.decode(value, { stream: true });
            const frames = carry.split("\n\n");
            carry = frames.pop() ?? "";
            for (const frame of frames) {
              const payload = frame.split("\n").find((row) => row.startsWith("data:"));
              if (!payload) continue;
              let chunk: { seq?: number; stream?: string; data?: string; closed?: number };
              try { chunk = JSON.parse(payload.slice(5).trim()); } catch { continue; }
              if (typeof chunk.seq === "number") cursor = chunk.seq;
              if (chunk.stream === "meta") {
                let meta: { exit?: number; cwd?: string; prompt?: string; command?: string; closed?: number };
                try { meta = JSON.parse(chunk.data ?? "{}"); } catch { continue; }
                if (meta.command !== undefined) append({ seq: chunk.seq!, kind: "cmd", text: `${meta.prompt ?? ""}$ ${meta.command}` });
                if (meta.cwd) setCwd(meta.cwd);
                if (meta.exit) append({ seq: chunk.seq! + 0.5, kind: "note", text: `exit ${meta.exit}` });
                if (meta.closed !== undefined) { append({ seq: chunk.seq! + 0.5, kind: "note", text: "The shell exited." }); setSession(null); }
                if (meta.command !== undefined) setBusy(true); else if (meta.exit !== undefined) setBusy(false);
                continue;
              }
              if (chunk.data) append({ seq: chunk.seq!, kind: chunk.stream === "err" ? "err" : "out", text: chunk.data.replace(/\n$/, "") });
            }
          }
        } catch {
          if (stopped) return;
        }
        if (stopped) return;
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempts, 4_000)));
      }
    };
    void consume();
    return () => { stopped = true; controller.abort(); };
  }, [session, append]);

  // Follow the tail, but only while the user is already at the bottom —
  // scrolling up to read an error and being yanked back down by the next line
  // of output is the behaviour that makes a log unreadable.
  useEffect(() => {
    const element = log.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const send = async (action: "run" | "interrupt", data?: string) => {
    if (!session) return;
    const response = await fetch("/api/terminal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sessionId: session, data }),
    }).then((r) => r.json()).catch(() => ({ error: "The shell is unreachable." }));
    if (response.error) setError(response.error);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const command = input.trim();
    if (!command || !session) return;
    history.current = [command, ...history.current.filter((entry) => entry !== command)].slice(0, 100);
    historyAt.current = -1;
    setInput("");
    setBusy(true);
    void send("run", command);
  };

  const recall = (delta: number) => {
    const next = historyAt.current + delta;
    if (next < 0) { historyAt.current = -1; setInput(""); return; }
    if (next >= history.current.length) return;
    historyAt.current = next;
    setInput(history.current[next]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={log}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="scroll-thin min-h-0 flex-1 overflow-auto bg-code-surface px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
      >
        {!lines.length && !error && (
          <p className="text-pebble">
            {session ? `A shell in ${rootLabel ?? "this folder"}. ` : "Opening a shell… "}
            {session && "No tty here, so vim, top and password prompts will not work."}
          </p>
        )}
        {error && <p className="text-alarm-red">{error}</p>}
        {lines.map((line) => (
          <pre
            key={line.seq}
            className={`whitespace-pre-wrap break-all ${
              line.kind === "cmd" ? "mt-1.5 font-semibold text-electric-indigo"
                : line.kind === "err" ? "text-alarm-red"
                : line.kind === "note" ? "text-pebble"
                : "text-bark-grey"
            }`}
          >
            {line.text}
          </pre>
        ))}
      </div>

      <form onSubmit={submit} className="flex shrink-0 items-center gap-1.5 border-t border-line/70 px-2 py-1.5">
        <span className="max-w-[38%] shrink-0 truncate font-mono text-[10.5px] text-pebble" title={cwd}>
          {cwd.split(/[\\/]/).at(-1) || "~"}
        </span>
        <input
          value={input}
          disabled={!session}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); recall(1); }
            else if (event.key === "ArrowDown") { event.preventDefault(); recall(-1); }
            else if (event.key === "c" && event.ctrlKey) { event.preventDefault(); void send("interrupt"); }
          }}
          placeholder={session ? "npm test" : "No shell"}
          aria-label="Terminal command"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-charcoal outline-none placeholder:text-pebble"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => void send("interrupt")}
            title="Interrupt (Ctrl-C)"
            aria-label="Interrupt the running command"
            className="shrink-0 rounded-md p-1 text-pebble transition-colors hover:bg-veil hover:text-alarm-red"
          >
            <Square className="size-3" strokeWidth={2.2} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!session || !input.trim()}
            title="Run"
            aria-label="Run the command"
            className="shrink-0 rounded-md p-1 text-pebble transition-colors hover:bg-veil hover:text-charcoal disabled:opacity-40"
          >
            {session ? <CornerDownLeft className="size-3.5" strokeWidth={1.8} /> : <Loader2 className="size-3.5 animate-spin" />}
          </button>
        )}
      </form>
    </div>
  );
}

export const TerminalIcon = TerminalSquare;
