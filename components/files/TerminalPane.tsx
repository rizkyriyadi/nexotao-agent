"use client";

/* The shell, in the folder the panel is already showing.
 *
 * Not an emulator. There is no tty behind this (see lib/terminal.ts for why),
 * so drawing a full VT100 would be dressing up a capability we do not have —
 * the log is plain text, and the two things that would mislead a user are said
 * out loud instead: full-screen programs and password prompts will not work.
 *
 * What it *does* copy from a real terminal is where the typing happens. The
 * input used to be a separate bar pinned below the log, which reads as a chat
 * box: the command you are composing sits somewhere other than the place its
 * output will appear, and the prompt showing the folder is duplicated — once
 * beside the input, once again in the echo after you press Enter. Here the
 * caret is on the last line of the log, after the prompt, and the output opens
 * directly beneath it. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw, Square, TerminalSquare } from "lucide-react";
import { isClearCommand, promptLabel, rememberCommand } from "./terminal-input";

/* `prompt` is kept apart from `text` rather than baked into it, so the echo of
 * a command can be shortened to `~/…` at render time by the same rule as the
 * live prompt. Formatting it when the line arrives would freeze whatever `home`
 * happened to be known then — and the stream effect does not re-run when it
 * arrives, so that is reliably "nothing". */
type Line = { seq: number; kind: "out" | "err" | "cmd" | "note"; text: string; prompt?: string };

const HISTORY = 500;

export function TerminalPane({ rootId, rootLabel }: { rootId: string | null; rootLabel?: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A shell that has exited is a state the user has to be able to leave. Without
  // this the panel sat on "No shell" and a spinner for good, and the only way
  // out was to reload the whole page — which also costs them the file tree, the
  // run they were watching, and the scrollback explaining what went wrong.
  const [dead, setDead] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const history = useRef<string[]>([]);
  const historyAt = useRef(-1);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
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
    // `cwd` resets too: left behind, the folder chip keeps naming the previous
    // root's directory while the new shell is somewhere else entirely.
    setLines([]); setSession(null); setError(null); setDead(false); setBusy(false); setCwd("");
    fetch("/api/terminal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", rootId }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        // A failure to open is the same dead end as a shell that exits, and it
        // needs the same way out: `openSession` skips a dead shell and builds a
        // fresh one, so retrying is meaningful rather than hopeful.
        if (data.error) { setError(data.error); setDead(true); return; }
        setSession(data.sessionId);
        setCwd(data.cwd);
        setHome(typeof data.home === "string" ? data.home : "");
      })
      .catch((cause) => { if (!cancelled) { setError(String(cause)); setDead(true); } });
    return () => { cancelled = true; };
  }, [rootId, attempt]);

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
              // The backoff resets here rather than on a successful *response*.
              // A 200 carrying nothing usable is still a 200, so resetting on
              // the response alone pinned the delay at its 500ms floor and the
              // reader hammered the route several times a second for as long as
              // the page stayed open. A real chunk is the only evidence the
              // connection is worth keeping.
              if (typeof chunk.seq === "number") { cursor = chunk.seq; attempts = 0; }
              // The stream route answers a session it has never heard of with a
              // bare `{"closed":-1}` — no `seq`, no `stream`. Dropping it (it
              // matches neither branch below) left the reader reconnecting every
              // 500ms forever against a session that does not exist, while the
              // input bar still invited the user to type commands that all 404.
              if (chunk.stream === undefined && chunk.closed !== undefined) {
                append({ seq: cursor + 0.5, kind: "note", text: "This shell is no longer available." });
                setSession(null); setBusy(false); setDead(true);
                stopped = true; controller.abort();
                return;
              }
              if (chunk.stream === "meta") {
                let meta: { exit?: number; cwd?: string; prompt?: string; command?: string; closed?: number; note?: string };
                try { meta = JSON.parse(chunk.data ?? "{}"); } catch { continue; }
                if (meta.command !== undefined) append({ seq: chunk.seq!, kind: "cmd", text: meta.command, prompt: meta.prompt ?? "" });
                if (meta.cwd) setCwd(meta.cwd);
                // The server says when it had to open somewhere other than the
                // folder that was asked for. Dropping it would leave the user in
                // a shell that is quietly in the wrong directory.
                if (meta.note) append({ seq: chunk.seq!, kind: "note", text: meta.note });
                if (meta.exit) append({ seq: chunk.seq! + 0.5, kind: "note", text: `exit ${meta.exit}` });
                if (meta.closed !== undefined) {
                  // The code matters: 0 is the user typing `exit`, 137 is the
                  // OOM killer, and "The shell exited." alone leaves someone
                  // whose shell was killed under memory pressure with no thread
                  // to pull. 0 is the unremarkable case, so it stays quiet.
                  append({
                    seq: chunk.seq! + 0.5, kind: "note",
                    text: meta.closed ? `The shell exited (code ${meta.closed}).` : "The shell exited.",
                  });
                  setSession(null); setBusy(false); setDead(true);
                  stopped = true; controller.abort();
                  return;
                }
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
  }, [lines, busy, session]);

  // The caret belongs in the shell the moment there is one. Opening the panel
  // and having to click the last line before typing works is the sort of thing
  // that makes a terminal feel like a form.
  useEffect(() => { if (session) field.current?.focus(); }, [session]);

  const send = async (action: "run" | "write" | "interrupt", data?: string) => {
    if (!session) return;
    const response = await fetch("/api/terminal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sessionId: session, data }),
    }).then((r) => r.json()).catch(() => ({ error: "The shell is unreachable." }));
    if (!response.error) return;
    /* Into the log, not a banner above it. The banner sits at the top of a pane
     * the user is pinned to the *bottom* of, so a failure printed there is
     * invisible at exactly the moment it matters. And `busy` was set
     * optimistically when the command was sent: leaving it set on a failed send
     * strands the Stop button in place of the prompt, doing nothing, with no way
     * back. */
    append({ seq: Date.now(), kind: "err", text: response.error });
    setBusy(false);
    if (response.error === "The shell has exited." || response.error === "That shell is gone. Open a new one.") {
      setSession(null); setDead(true);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const command = input.trim();
    if (!session) return;

    /* A command already running owns stdin. Sending this as a *command* would
     * write our exit-code marker into it too, so the program consumes the
     * marker as input and the panel never learns the command finished. Raw
     * stdin is what a real terminal does with a line typed at a running
     * program, and it is what makes an interactive prompt answerable. */
    if (busy) {
      append({ seq: Date.now(), kind: "out", text: input });
      setInput("");
      void send("write", `${input}\n`);
      return;
    }

    if (!command) return;
    history.current = rememberCommand(history.current, command);
    historyAt.current = -1;
    setInput("");

    /* `clear` asks the *terminal* to wipe its screen — normally an escape
     * sequence an emulator interprets. We have no emulator and say so honestly
     * with `TERM=dumb`, and a dumb terminal has no clear capability, so the
     * shell's `clear` exits 1 having printed nothing. The screen this shell has
     * is this log, so the clear happens here. */
    if (isClearCommand(command)) {
      setLines([]);
      return;
    }

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
    <div
      ref={log}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
      /* Clicking anywhere in the log puts the caret back on the prompt, the way
       * clicking a terminal window does — but not when there is a selection, or
       * copying an error message would dismiss it on mouse-up. */
      onMouseUp={() => {
        if (!window.getSelection()?.toString()) field.current?.focus();
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
          {line.prompt !== undefined && `${promptLabel(line.prompt, home)}$ `}
          {line.text}
        </pre>
      ))}

      {/* The live prompt: the last line of the log, not a bar beneath it. It
          carries the same folder text as the echo of every command above it, so
          what you are typing lines up with what you already ran. */}
      {session && (
        <form onSubmit={submit} className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
          {busy ? (
            <>
              <Loader2 className="size-3 shrink-0 animate-spin self-center text-pebble" />
              <button
                type="button"
                onClick={() => void send("interrupt")}
                title="Interrupt (Ctrl-C)"
                aria-label="Interrupt the running command"
                className="shrink-0 self-center rounded p-0.5 text-pebble transition-colors hover:bg-veil hover:text-alarm-red"
              >
                <Square className="size-3" strokeWidth={2.2} />
              </button>
            </>
          ) : (
            <span className="shrink-0 font-semibold text-electric-indigo">{promptLabel(cwd, home)}$</span>
          )}
          <input
            ref={field}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") { event.preventDefault(); recall(1); }
              else if (event.key === "ArrowDown") { event.preventDefault(); recall(-1); }
              else if (event.key === "c" && event.ctrlKey) { event.preventDefault(); void send("interrupt"); }
              else if (event.key === "l" && event.ctrlKey) { event.preventDefault(); setLines([]); }
            }}
            placeholder={busy ? "" : "npm test"}
            aria-label="Terminal command"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-[6rem] flex-1 bg-transparent font-mono text-[11.5px] leading-[1.55] text-charcoal caret-electric-indigo outline-none placeholder:text-pebble"
          />
        </form>
      )}

      {dead && (
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="mt-2 flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-bark-grey transition-colors hover:bg-veil hover:text-charcoal"
        >
          <RotateCw className="size-3" strokeWidth={1.8} /> Start a new shell
        </button>
      )}
    </div>
  );
}

export const TerminalIcon = TerminalSquare;
