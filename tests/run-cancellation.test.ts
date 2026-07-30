import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { agents, projects } from "../lib/db/schema";
import { DurableHeartbeatRuntime } from "../lib/heartbeat-runtime";
import { createRunEventStream } from "../lib/run-event-stream";
import { isTerminalRunEvent } from "../lib/run-events";
import { RUN_RESULT_EVENT_TYPE, TEXT_DELTA_EVENT_TYPES } from "../lib/run-transcript";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-cancel-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Cancel", path: dir, createdAt: 1 }).run());
  const repositories = new ControlPlaneRepositories(database);
  await repositories.agents.insert({ id: "a", projectId: "p", name: "Agent", role: "worker", scope: "Cancel", createdAt: 2, updatedAt: 2 });
  await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Task", status: "todo", assigneeAgentId: "a", createdAt: 3, updatedAt: 3 });
  return { dir, database, repositories };
}

/** Claim a wakeup and check the issue out to it, exactly as the executor does. */
async function startRun(repositories: ControlPlaneRepositories, key: string) {
  await repositories.enqueueHeartbeat({ agentId: "a", issueId: "i", reason: "assignment", idempotencyKey: key });
  const claimed = await repositories.claimNextHeartbeat();
  assert.ok(claimed, "the queued heartbeat is claimable");
  const runId = claimed!.heartbeat.id;
  assert.ok(await repositories.checkoutIssue("i", "a", runId), "the run owns the issue");
  return runId;
}

test("cancelling releases the issue even when the in-memory run is gone, and is idempotent", async () => {
  const f = await fixture();
  try {
    const runId = await startRun(f.repositories, "assignment:i:1");
    assert.equal(f.repositories.issues.get("i")?.status, "in_progress");

    // A fresh runtime has no AbortController for this run — the same situation
    // as a server restart, a GC'd Run, or a cancel served by another worker.
    const runtime = new DurableHeartbeatRuntime(f.repositories, async () => {});
    assert.equal(await runtime.cancel(runId, "stop"), true);
    const cancelled = f.repositories.issues.get("i");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.checkoutRunId, null);
    assert.equal(cancelled?.executionLockedAt, null);
    assert.equal(f.repositories.getHeartbeat(runId)?.status, "cancelled");

    // Cancelling twice must not throw and must still report success, so the UI
    // never sees a 404 for a run it just cancelled.
    assert.equal(await runtime.cancel(runId, "stop"), true);
    assert.equal(f.repositories.issues.get("i")?.status, "cancelled");
    assert.equal(await runtime.cancel("missing-run"), false, "an unknown run id is still not found");

    const actions = f.repositories.listActivity("issue", "i").map((row) => row.action);
    assert.ok(actions.includes("issue.transitioned"), "the release is audited through the lifecycle");
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("cancelling a superseded run leaves the newer run's checkout alone", async () => {
  const f = await fixture();
  try {
    const first = await startRun(f.repositories, "assignment:i:1");
    await f.repositories.completeHeartbeat(first, "succeeded", { status: "succeeded" });
    await f.repositories.issues.update("i", { status: "todo", checkoutRunId: null, executionLockedAt: null });
    const second = await startRun(f.repositories, "assignment:i:2");

    const runtime = new DurableHeartbeatRuntime(f.repositories, async () => {});
    await runtime.cancel(first, "stop");
    const issue = f.repositories.issues.get("i");
    assert.equal(issue?.status, "in_progress");
    assert.equal(issue?.checkoutRunId, second);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("a restart releases issues whose run will never resume, but not requeued work", async () => {
  const f = await fixture();
  try {
    const abandoned = await startRun(f.repositories, "assignment:i:1");
    // The run reached a terminal state without anything clearing the checkout —
    // the exact shape of the stranded "forever running" task.
    await f.repositories.completeHeartbeat(abandoned, "failed", { status: "failed" }, { error: "crashed" });
    assert.equal(f.repositories.issues.get("i")?.status, "in_progress");

    // Booting also drains, so let that settle before reading: otherwise the
    // recovered wakeup is still executing and holds the agent's one slot.
    const rebooted = new DurableHeartbeatRuntime(f.repositories, async () => {});
    await rebooted.initialize();
    await rebooted.shutdown();
    const recovered = f.repositories.issues.get("i");
    assert.equal(recovered?.status, "todo", "the stranded task is runnable again, not stuck running");
    assert.equal(recovered?.checkoutRunId, null);

    // An orphaned run that recovery requeued keeps its checkout: it is about to
    // execute again, so releasing it would double-start the task.
    await f.database.write((db) => db.update(agents).set({ status: "idle", errorReason: null }).where(eq(agents.id, "a")).run());
    const live = await startRun(f.repositories, "assignment:i:2");
    const again = new DurableHeartbeatRuntime(f.repositories, async () => {});
    await again.initialize();
    assert.equal(f.repositories.issues.get("i")?.checkoutRunId, live);
    await again.shutdown();
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("a full replay renders the answer exactly once and ends on a recognised terminal event", async () => {
  const f = await fixture();
  try {
    const runId = await startRun(f.repositories, "assignment:i:1");
    const deltas = ["Looked ", "at the ", "code.\n", "All good."];
    // What a live client accumulates: the deltas as they stream.
    for (const text of deltas) await f.repositories.appendHeartbeatEvent(runId, "reasoning_summary", { text, thread: "lead" });
    await f.repositories.appendHeartbeatEvent(runId, "tool_call", { id: "t1", name: "read_file", input: { path: "README.md" } });
    // The executor's final summary. It repeats the deltas verbatim, so a replay
    // that appended it too would show the whole answer twice.
    await f.repositories.appendHeartbeatEvent(runId, RUN_RESULT_EVENT_TYPE, { text: deltas.join(""), thread: "lead" });
    const terminal = await f.repositories.completeHeartbeat(runId, "succeeded", { status: "succeeded" });

    const reader = createRunEventStream(f.repositories, runId, 0).getReader();
    let replayed = "";
    let closingType = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      for (const frame of new TextDecoder().decode(result.value).split("\n\n")) {
        const line = frame.split("\n").find((row) => row.startsWith("data:"));
        if (!line) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (TEXT_DELTA_EVENT_TYPES.has(event.type)) replayed += String(event.payload.text ?? "");
        closingType = event.type;
      }
    }
    assert.equal(replayed, deltas.join(""), "replay is byte-identical to the live stream");
    assert.equal(closingType, terminal.event.type);
    assert.ok(isTerminalRunEvent(closingType), "the stream's last event closes the client's run");
    assert.equal(TEXT_DELTA_EVENT_TYPES.has(RUN_RESULT_EVENT_TYPE), false, "the final summary is never appended as text");
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("every terminal heartbeat status emits an event the stream and client recognise", async () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const f = await fixture();
    try {
      const runId = await startRun(f.repositories, `assignment:i:${status}`);
      const { event } = await f.repositories.completeHeartbeat(runId, status, { status });
      assert.ok(isTerminalRunEvent(event.type), `${status} emits a terminal type (${event.type})`);
      // The client closes on this exact set; a type outside it hangs the UI on
      // "running" after the run has really ended.
      assert.ok(["success", "failure", "cancellation", "done", "error", "cancelled"].includes(event.type));
    } finally {
      await f.database.close();
      await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
});
