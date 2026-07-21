import { getActiveRun, getRun, type RunEvent } from "@/lib/run-manager";
import { getRunRecord } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 800;

const sse = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });

/** Reconnectable live stream for a run. Replays the full event log (so a client
 * that refreshed / switched tabs sees everything it missed) then tails live.
 * Look up by ?session= (survives refresh — the id is in the URL) or ?runId=.
 * If the run is no longer in memory (finished/GC'd/restart), replay it from disk. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session");
  const runId = url.searchParams.get("runId");
  const run = runId ? getRun(runId) : sessionId ? getActiveRun(sessionId) : undefined;

  if (!run) {
    // not live — replay the saved log from disk so a past run stays viewable
    if (runId) {
      const rec = await getRunRecord(runId);
      if (rec) {
        const body = rec.events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
          `data: ${JSON.stringify({ type: rec.status === "error" ? "error" : rec.status === "cancelled" ? "cancelled" : "done", error: "" })}\n\n`;
        return sse(body);
      }
    }
    // no run — tell the client so it just shows saved messages
    return sse(`data: ${JSON.stringify({ type: "idle" })}\n\n`);
  }

  const encoder = new TextEncoder();
  let unsub = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: RunEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* closed */ }
        if (e.type === "done" || e.type === "error" || e.type === "cancelled") {
          closed = true;
          unsub();
          try { controller.close(); } catch { /* already closed */ }
        }
      };
      // replay the log, then tail live (atomic — no events dropped between)
      unsub = run.subscribe(send);
    },
    cancel() {
      // browser disconnected (refresh / tab close): stop tailing, but the RUN
      // itself keeps going in the backend and can be reconnected.
      unsub();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
