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
  void catchUpCodeIndexes();
}

/**
 * Bring every project's code index up to date after a restart — the app was
 * closed while the user committed from their terminal, and the first graph_query
 * of the next run would otherwise answer from a stale index.
 *
 * Deliberately not awaited, and deliberately **sequential**: eight projects
 * indexing at once is a thundering herd of tree-sitter workers competing with
 * the page the user is waiting on. Ends with one cache sweep, which is the only
 * moment we can safely tell an orphaned index from a live one.
 */
async function catchUpCodeIndexes() {
  try {
    const [{ listProjects }, { refreshCodeIndex, sweepCodeIndexCache, detectCodeMemory }] = await Promise.all([
      import("./lib/store"),
      import("./lib/code-memory"),
    ]);
    // One probe, so an uninstalled binary costs one spawn rather than one per project.
    if (!(await detectCodeMemory())) return;
    const projects = await listProjects();
    for (const project of projects) {
      await refreshCodeIndex(project.id, project.path, { mode: "fast" }).catch(() => null);
    }
    await sweepCodeIndexCache({ knownProjectIds: projects.map((project) => project.id) }).catch(() => null);
  } catch {
    /* the code layer is optional; boot never depends on it */
  }
}
