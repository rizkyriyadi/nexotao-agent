import { getSession, type TerminalChunk } from "@/lib/terminal";

export const runtime = "nodejs";
export const maxDuration = 800;

/** Live output for one shell. Same shape as the run stream: replay everything
 *  after the client's cursor, then tail — subscribing *before* the replay so a
 *  chunk that lands between the two is not dropped, and de-duplicating by `seq`
 *  so it is not shown twice either. A refresh therefore rejoins mid-command with
 *  its scrollback intact. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = getSession(url.searchParams.get("session") ?? "");
  if (!session) return new Response("data: {\"closed\":-1}\n\n", { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });

  const cursor = Number(request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? 0) || 0;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let keepalive: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let sent = cursor;
      const emit = (chunk: TerminalChunk) => {
        if (closed || chunk.seq <= sent) return;
        sent = chunk.seq;
        try { controller.enqueue(encoder.encode(`id: ${chunk.seq}\ndata: ${JSON.stringify(chunk)}\n\n`)); } catch { closed = true; }
      };
      // Live chunks are held aside until the replay has been written. Emitting
      // them straight away would advance the cursor past the backlog and the
      // replay would then be skipped as "already sent" — the scrollback would
      // silently lose whatever happened before the client connected.
      let backlog: TerminalChunk[] | null = [];
      unsubscribe = session.subscribe((chunk) => (backlog ? backlog.push(chunk) : emit(chunk)));
      for (const chunk of session.since(cursor)) emit(chunk);
      const queued = backlog;
      backlog = null;
      for (const chunk of queued) emit(chunk);
      keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { closed = true; }
      }, 15_000);
      keepalive.unref?.();
    },
    cancel() {
      unsubscribe();
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
