import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";
import { createRunEventStream } from "../lib/run-event-stream";
import { MAX_RUN_EVENT_BYTES, publishRunEvent, RunEventDomainError } from "../lib/run-events";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-events-test-"));
  const database = await openDatabase(path.join(dir, "events.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Events", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  const repositories = new ControlPlaneRepositories(database);
  await repositories.agents.insert({ id: "a", projectId: "p", name: "Realtime", role: "worker", scope: "SSE", createdAt: 2, updatedAt: 2 });
  await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Stream", status: "in_progress", assigneeAgentId: "a", createdAt: 3, updatedAt: 3 });
  const run = await repositories.createHeartbeat({ agentId: "a", issueId: "i", source: "assignment", status: "running", startedAt: 4, updatedAt: 4 });
  return { dir, database, repositories, runId: run.id };
}

function decode(value: Uint8Array | undefined) {
  return new TextDecoder().decode(value);
}

test("run events are sequenced, redacted, bounded, and immutable after terminal", async () => {
  const f = await fixture();
  try {
    const [one, two] = await Promise.all([
      f.repositories.appendHeartbeatEvent(f.runId, "tool_call", { authorization: "Bearer secret-token-value", body: "x".repeat(100_000) }),
      f.repositories.appendHeartbeatEvent(f.runId, "usage", { inputTokens: 4, outputTokens: 2 }),
    ]);
    assert.deepEqual([one.seq, two.seq].sort((a, b) => a - b), [1, 2]);
    const stored = f.repositories.listRunEvents(f.runId);
    assert.equal(stored.length, 2);
    assert.equal(JSON.stringify(stored[0].redactedPayload).includes("secret-token-value"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(stored[0].redactedPayload)) <= MAX_RUN_EVENT_BYTES);
    const terminal = await f.repositories.completeHeartbeat(f.runId, "succeeded", { status: "succeeded" });
    assert.equal(terminal.event.seq, 3);
    assert.equal(f.repositories.getHeartbeat(f.runId)?.status, "succeeded");
    await assert.rejects(
      f.repositories.appendHeartbeatEvent(f.runId, "output", { text: "too late" }),
      (error: unknown) => error instanceof RunEventDomainError && error.code === "terminal",
    );
    assert.equal(f.repositories.listIssueRunEvents("i").length, 3);
    assert.equal(f.repositories.listProjectRunEvents("p").length, 3);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("SSE disconnect and cursor reconnect replay without gaps or duplicate sequence delivery", async () => {
  const f = await fixture();
  try {
    const first = await f.repositories.appendHeartbeatEvent(f.runId, "reasoning_summary", { text: "one" });
    const initialReader = createRunEventStream(f.repositories, f.runId, 0).getReader();
    assert.match(decode((await initialReader.read()).value), /"seq":1/);
    await initialReader.cancel();

    const second = await f.repositories.appendHeartbeatEvent(f.runId, "tool_call", { id: "t", name: "read_file", input: { path: "README.md" } });
    const resumedReader = createRunEventStream(f.repositories, f.runId, first.seq).getReader();
    publishRunEvent(second); // duplicate transport delivery is ignored by the stream cursor
    const terminal = await f.repositories.completeHeartbeat(f.runId, "succeeded", { status: "succeeded" });
    const replayed = decode((await resumedReader.read()).value);
    const completed = decode((await resumedReader.read()).value);
    assert.match(replayed, /"seq":2/);
    assert.doesNotMatch(replayed, /"seq":1/);
    assert.match(completed, new RegExp(`"seq":${terminal.event.seq}`));
    assert.equal((await resumedReader.read()).done, true);

    const sequences = f.repositories.listRunEvents(f.runId).map((event) => event.seq);
    assert.deepEqual(sequences, [1, 2, 3]);
    assert.equal(new Set(sequences).size, sequences.length);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("SSE paginates long replay windows and closes when terminal cursor is current", async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 501; index += 1) {
      await f.repositories.appendHeartbeatEvent(f.runId, "output", { text: String(index) });
    }
    const terminal = await f.repositories.completeHeartbeat(f.runId, "succeeded", { status: "succeeded" });
    const reader = createRunEventStream(f.repositories, f.runId, 0).getReader();
    const sequences: number[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const match = decode(result.value).match(/"seq":(\d+)/);
      if (match) sequences.push(Number(match[1]));
    }
    assert.equal(sequences.length, 502);
    assert.deepEqual(sequences, Array.from({ length: 502 }, (_, index) => index + 1));

    const currentReader = createRunEventStream(f.repositories, f.runId, terminal.event.seq).getReader();
    assert.equal((await currentReader.read()).done, true);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
