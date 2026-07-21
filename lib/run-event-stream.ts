import type { ControlPlaneRepositories } from "./db/repositories";
import { encodeRunEvent, isTerminalRunEvent, subscribeRunEvents, type DurableRunEvent } from "./run-events";

/** Subscribe before replay, buffer live arrivals during the snapshot, then
 * deduplicate by sequence. This closes the usual replay/tail race window. */
export function createRunEventStream(repositories: ControlPlaneRepositories, runId: string, cursor = 0) {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let replaying = true;
      let lastSent = cursor;
      const pending: DurableRunEvent[] = [];
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (keepalive) clearInterval(keepalive);
        try { controller.close(); } catch {}
      };
      const send = (event: DurableRunEvent) => {
        if (closed || event.seq <= lastSent) return;
        lastSent = event.seq;
        controller.enqueue(encoder.encode(encodeRunEvent(event)));
        if (isTerminalRunEvent(event.type)) close();
      };

      unsubscribe = subscribeRunEvents(runId, (event) => {
        if (replaying) pending.push(event);
        else send(event);
      });
      // Read every page before switching to the live tail. A single bounded
      // query would silently skip events on long runs once the replay window
      // exceeded the repository's page size.
      let replayCursor = cursor;
      while (!closed) {
        const page = repositories.listRunEvents(runId, replayCursor, 500);
        if (!page.length) break;
        for (const event of page) send(event);
        replayCursor = page[page.length - 1]!.seq;
        if (page.length < 500) break;
      }
      replaying = false;
      for (const event of pending.sort((a, b) => a.seq - b.seq)) send(event);
      // A browser can reconnect with Last-Event-ID already pointing at the
      // terminal event. There is nothing left to replay or tail in that case.
      if (!closed && ["succeeded", "failed", "cancelled"].includes(repositories.getHeartbeat(runId)?.status ?? "")) close();
      if (!closed) keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { close(); }
      }, 15_000);
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (keepalive) clearInterval(keepalive);
    },
  });
}
