/** Boot hook. The heartbeat runtime is otherwise built lazily, on whichever
 *  request first happens to tick — so work queued before a restart sat there
 *  looking queued until unrelated traffic arrived to wake it. Constructing the
 *  runtime here drains that backlog as soon as the server is up. */
export async function register() {
  // Only the Node server owns the queue; the edge runtime has no database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { resumeQueuedWork } = await import("./lib/executor");
  // Never block boot on it: a failed drain must leave a serving app behind, not
  // a crash loop that also takes the UI down.
  await resumeQueuedWork().catch(() => {});
}
