import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories, MAX_WAKEUP_ATTEMPTS } from "../lib/db/repositories";
import { issues, projects, wakeupRequests } from "../lib/db/schema";
import { DurableHeartbeatRuntime } from "../lib/heartbeat-runtime";

/* A run that takes the process down with it is requeued by boot recovery,
   claimed again, and takes the process down again. The attempt counter existed
   for exactly this and was read by nothing, so the loop had no end and no
   surface anywhere said why. These tests pin the ceiling: the queue gives up,
   the run ends in a terminal event a transcript can render, and the task lands
   somewhere a human can see it. */

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-retry-bound-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Loop", path: dir, createdAt: 1 }).run());
  const repositories = new ControlPlaneRepositories(database);
  await repositories.agents.insert({ id: "a", projectId: "p", name: "Agent", role: "worker", scope: "x", createdAt: 2, updatedAt: 2 });
  await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Poison", status: "todo", assigneeAgentId: "a", createdAt: 3, updatedAt: 3 });
  return { dir, database, repositories };
}

test("a run that keeps crashing the process is eventually retired instead of looping forever", async () => {
  const f = await fixture();
  try {
    await f.repositories.enqueueHeartbeat({ agentId: "a", issueId: "i", reason: "assignment", idempotencyKey: "assignment:i:1" });

    // Each pass is one boot that claims the poisonous run and dies before it can
    // complete — precisely what orphan recovery then puts back on the queue.
    let claims = 0;
    for (let boot = 0; boot < MAX_WAKEUP_ATTEMPTS + 3; boot++) {
      await f.repositories.recoverOrphanedHeartbeats();
      await f.repositories.abandonExhaustedHeartbeats();
      if (await f.repositories.claimNextHeartbeat()) claims++;
    }

    assert.equal(claims, MAX_WAKEUP_ATTEMPTS, "the run is claimed a bounded number of times, then never again");
    const wakeup = f.database.read((db) => db.select().from(wakeupRequests).where(eq(wakeupRequests.agentId, "a")).get())!;
    assert.equal(wakeup.status, "failed");
    assert.match(wakeup.lastError ?? "", /gave up/i);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("retiring a run closes its transcript and hands the task back to a human", async () => {
  const f = await fixture();
  try {
    await f.repositories.enqueueHeartbeat({ agentId: "a", issueId: "i", reason: "assignment", idempotencyKey: "assignment:i:1" });
    let runId = "";
    for (let boot = 0; boot < MAX_WAKEUP_ATTEMPTS; boot++) {
      await f.repositories.recoverOrphanedHeartbeats();
      const claimed = await f.repositories.claimNextHeartbeat();
      if (claimed) {
        runId = claimed.heartbeat.id;
        // What the executor does first on every attempt: take the task. Each
        // crash leaves it checked out, which is why the checkout has to be
        // released by whoever retires the run.
        await f.repositories.checkoutIssue("i", "a", runId);
      }
    }
    await f.repositories.appendHeartbeatEvent(runId, "output", { text: "half a thought" });

    await f.repositories.recoverOrphanedHeartbeats();
    assert.equal(await f.repositories.abandonExhaustedHeartbeats(), 1);

    // A transcript reader needs a terminal event or the run renders as still
    // running for good — the state this whole path exists to escape.
    const events = f.repositories.listRunEvents(runId);
    assert.equal(events.at(-1)?.type, "failure");
    assert.equal(f.repositories.getHeartbeat(runId)?.status, "failed");

    // And the task must not stay checked out to a run that will never resume.
    const issue = f.database.read((db) => db.select().from(issues).where(eq(issues.id, "i")).get())!;
    assert.equal(issue.status, "in_review");
    assert.equal(issue.checkoutRunId, null);
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("a human clicking retry gets a fresh budget", async () => {
  const f = await fixture();
  try {
    await f.repositories.enqueueHeartbeat({ agentId: "a", issueId: "i", reason: "assignment", idempotencyKey: "assignment:i:1" });
    let runId = "";
    for (let boot = 0; boot < MAX_WAKEUP_ATTEMPTS; boot++) {
      await f.repositories.recoverOrphanedHeartbeats();
      const claimed = await f.repositories.claimNextHeartbeat();
      if (claimed) runId = claimed.heartbeat.id;
    }
    // Exhausted: recovery alone can no longer get this run claimed.
    await f.repositories.recoverOrphanedHeartbeats();
    assert.equal(await f.repositories.claimNextHeartbeat(), null);

    const runtime = new DurableHeartbeatRuntime(f.repositories, async () => {});
    assert.equal(await runtime.retry(runId, Date.now()), true);
    assert.equal(
      f.database.read((db) => db.select().from(wakeupRequests).where(eq(wakeupRequests.agentId, "a")).get())?.attempt,
      0,
      "the person has usually changed something; a retry button that cannot run is worse than none",
    );
    await runtime.shutdown();
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
