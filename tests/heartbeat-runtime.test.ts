import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";
import { DurableHeartbeatRuntime } from "../lib/heartbeat-runtime";
import { NexotaoGatewayAdapter } from "../lib/runtime-adapter";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-heartbeat-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Runtime", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  const repositories = new ControlPlaneRepositories(database);
  await repositories.agents.insert({ id: "a", projectId: "p", name: "Agent", role: "worker", scope: "Runtime", runtimeConfig: { concurrency: 1 }, createdAt: 2, updatedAt: 2 });
  for (const [id, identifier] of [["i1", "NX-1"], ["i2", "NX-2"]]) {
    await repositories.issues.insert({ id, projectId: "p", identifier, title: id, status: "todo", assigneeAgentId: "a", createdAt: 3, updatedAt: 3 });
  }
  return { dir, database, repositories };
}

async function waitFor<T>(read: () => T, expected: T, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(read(), expected);
}

test("wakeup idempotency, per-agent concurrency, and restart recovery are durable", async () => {
  const f = await fixture();
  try {
    const first = await f.repositories.enqueueHeartbeat({ agentId: "a", issueId: "i1", reason: "assignment", idempotencyKey: "assignment:i1:1" });
    const duplicateTrigger = await f.repositories.enqueueHeartbeat({ agentId: "a", issueId: "i1", reason: "mention", idempotencyKey: "mention:i1:1" });
    assert.equal(duplicateTrigger.wakeup.id, first.wakeup.id, "different triggers cannot duplicate active work");
    await f.repositories.enqueueHeartbeat({ agentId: "a", issueId: "i2", reason: "invoke", idempotencyKey: "invoke:i2:1" });
    const claimed = await f.repositories.claimNextHeartbeat();
    assert.equal(claimed?.wakeup.issueId, "i1");
    assert.equal(await f.repositories.claimNextHeartbeat(), null, "concurrency=1 blocks a second claim");
    await f.database.close();

    const reopened = await openDatabase(path.join(f.dir, "nexotao.sqlite"), { migrateJson: false });
    const repositories = new ControlPlaneRepositories(reopened);
    assert.equal(repositories.listWakeups().length, 2);
    assert.equal(await repositories.recoverOrphanedHeartbeats(), 1);
    assert.equal(repositories.listWakeups("queued").length, 2);
    assert.ok(await repositories.claimNextHeartbeat(), "the recovered record is claimable without a new execution row");
    assert.equal(repositories.listHeartbeats("a").length, 2);
    await reopened.close();
  } finally { await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
});

test("heartbeat runtime persists waiting, success, failure, and cancellation", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new DurableHeartbeatRuntime(f.repositories, async (job, context) => {
      if (job.wakeup.issueId === "i1") {
        await context.waiting("approval");
        await gate;
        return { sessionAfter: "session-2", usage: { inputTokens: 7, outputTokens: 3 } };
      }
      throw new Error("gateway failed");
    });
    const one = await runtime.enqueue({ agentId: "a", issueId: "i1", reason: "approval", eventId: "approval-1" });
    await waitFor(() => f.repositories.getHeartbeat(one.heartbeat.id)?.status, "waiting");
    release();
    await runtime.runUntilIdle();
    assert.equal(f.repositories.getHeartbeat(one.heartbeat.id)?.status, "succeeded");
    assert.equal(f.repositories.getHeartbeat(one.heartbeat.id)?.sessionAfter, "session-2");

    const two = await runtime.enqueue({ agentId: "a", issueId: "i2", reason: "retry", eventId: "retry-1" });
    await runtime.runUntilIdle();
    assert.equal(f.repositories.getHeartbeat(two.heartbeat.id)?.status, "failed");
    await runtime.shutdown();

    const cancelledRuntime = new DurableHeartbeatRuntime(f.repositories, async (_job, context) => {
      await new Promise<void>((_resolve, reject) => {
        if (context.signal.aborted) return reject(context.signal.reason);
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    const cancelled = await cancelledRuntime.enqueue({ agentId: "a", reason: "invoke", eventId: "cancel-1" });
    await waitFor(() => f.repositories.getHeartbeat(cancelled.heartbeat.id)?.status, "running");
    assert.equal(await cancelledRuntime.cancel(cancelled.heartbeat.id, "stop"), true);
    await cancelledRuntime.runUntilIdle();
    assert.equal(f.repositories.getHeartbeat(cancelled.heartbeat.id)?.status, "cancelled");
    assert.ok(f.repositories.listRunEvents(cancelled.heartbeat.id).some((event) => event.type === "cancelled"));
    await cancelledRuntime.shutdown();
    await f.database.close();
  } finally { await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
});

test("Nexotao adapter streams events, reports usage, resumes sessions, and cancels", async () => {
  let calls = 0;
  const client = { messages: { create: async () => {
    calls += 1;
    return (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 0 } } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } };
    })();
  } } } as unknown as Anthropic;
  const adapter = new NexotaoGatewayAdapter("test", client);
  assert.deepEqual(adapter.capabilities(), { streaming: true, cancellation: true, usage: true, sessionResume: true, tools: true });
  const execution = await adapter.execute({ model: "model", messages: [{ role: "user", content: "hi" }] });
  const events = [];
  for await (const event of adapter.events(execution.executionId)) events.push(event);
  assert.ok(events.some((event) => event.type === "text" && event.text === "hello"));
  assert.deepEqual(await adapter.usage(execution.executionId), { inputTokens: 4, outputTokens: 2 });
  const resumed = await adapter.resume({ sessionId: execution.sessionId, model: "model", messages: [{ role: "user", content: "again" }] });
  for await (const event of adapter.events(resumed.executionId)) assert.ok(event.type);
  assert.equal(calls, 2);

  let childCancelled = false;
  const blockingClient = { messages: { create: async (_input: unknown, options: { signal: AbortSignal }) => (async function* () {
    if (options.signal.aborted) throw options.signal.reason;
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  })() } } as unknown as Anthropic;
  const cancellable = new NexotaoGatewayAdapter("test", blockingClient);
  const active = await cancellable.execute({ model: "model", messages: [{ role: "user", content: "wait" }], onCancel: () => { childCancelled = true; } });
  assert.equal(await cancellable.cancel(active.executionId, "stop"), true);
  const cancelledEvents = [];
  for await (const event of cancellable.events(active.executionId)) cancelledEvents.push(event);
  assert.equal(childCancelled, true);
  assert.ok(cancelledEvents.some((event) => event.type === "cancelled"));
});
