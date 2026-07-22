import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";
import { DurableHeartbeatRuntime } from "../lib/heartbeat-runtime";
import {
  budgetStatus, computeCost, crossedThresholds, resolvePricing, settleUsage, FALLBACK_PRICING,
} from "../lib/cost-ledger";

async function fixture(agents: { id: string; name: string; budgetLimit?: number | null }[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-cost-test-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Costs", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  const repositories = new ControlPlaneRepositories(database);
  for (const agent of agents) {
    await repositories.agents.insert({
      id: agent.id, projectId: "p", name: agent.name, role: "worker", scope: "Costs",
      budgetLimit: agent.budgetLimit ?? null, createdAt: 2, updatedAt: 2,
    });
  }
  return { dir, database, repositories };
}

const cleanup = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
const HAIKU = "claude-haiku-4-5";
// 100k output tokens on haiku ($5 / 1M output) == $0.50, a convenient budget unit.
const outputCost = (tokens: number) => computeCost(HAIKU, 0, tokens);

test("pricing resolves known models and falls back for unknown ones", () => {
  assert.deepEqual(resolvePricing("claude-opus-4-8"), { input: 15, output: 75 });
  assert.deepEqual(resolvePricing("claude-haiku-4-5-20251001"), { input: 1, output: 5 }, "dated aliases match by prefix");
  assert.deepEqual(resolvePricing("gpt-5.3-codex-spark"), FALLBACK_PRICING, "uncatalogued models degrade to the fallback price");
  assert.equal(computeCost(HAIKU, 1_000_000, 1_000_000), 6);
  assert.equal(computeCost(HAIKU, -10, -10), 0, "negative token counts are clamped");
});

test("settleUsage collapses cumulative samples to the per-model maximum", () => {
  const settled = settleUsage([
    { model: HAIKU, inputTokens: 10, outputTokens: 2 },
    { model: HAIKU, inputTokens: 40, outputTokens: 9 },
    { model: HAIKU, inputTokens: 25, outputTokens: 9 },
  ]);
  assert.equal(settled.length, 1);
  assert.deepEqual({ input: settled[0].inputTokens, output: settled[0].outputTokens }, { input: 40, output: 9 });
});

test("threshold math reports only newly crossed marks", () => {
  assert.deepEqual(crossedThresholds(0, 0.85, 1), [0.5, 0.8]);
  assert.deepEqual(crossedThresholds(0.85, 0.95, 1), [0.9]);
  assert.deepEqual(crossedThresholds(0.95, 1.2, 1), [], "over-budget crossings past 0.9 are handled as exhaustion");
  assert.deepEqual(crossedThresholds(0.4, 0.6, null), [], "no budget means no thresholds");
  assert.ok(budgetStatus(1, 1).exhausted, "spend at the limit is exhausted");
  assert.equal(budgetStatus(5, null).state, "ok");
});

test("retry chains that reuse a runId never double-count", async () => {
  const f = await fixture([{ id: "a", name: "Worker" }]);
  try {
    const first = await f.repositories.settleRunCost({ runId: "r1", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 100_000 }] });
    assert.equal(first.runCost, outputCost(100_000));
    // The same run settles again with the final (larger) usage after a retry.
    const retry = await f.repositories.settleRunCost({ runId: "r1", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 120_000 }] });
    assert.equal(retry.totalSpend, outputCost(120_000), "re-settle overwrites the prior row");
    assert.equal(f.repositories.agentSpend("a"), outputCost(120_000));
    assert.equal(f.repositories.agents.get("a")?.spentAmount, outputCost(120_000));
  } finally { await cleanup(f.dir); }
});

test("concurrent settlements across runs sum without lost updates", async () => {
  const f = await fixture([{ id: "a", name: "Worker" }]);
  try {
    await Promise.all([100_000, 60_000, 40_000, 20_000].map((tokens, index) =>
      f.repositories.settleRunCost({ runId: `run-${index}`, agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: tokens }] })));
    const expected = outputCost(100_000) + outputCost(60_000) + outputCost(40_000) + outputCost(20_000);
    assert.equal(f.repositories.agentSpend("a"), expected);
    assert.equal(f.repositories.agents.get("a")?.spentAmount, expected, "the cached spend matches the ledger after concurrent writes");
  } finally { await cleanup(f.dir); }
});

test("each warning threshold and the hard stop emit exactly one deduplicated event", async () => {
  const f = await fixture([{ id: "a", name: "Worker", budgetLimit: 1 }]);
  try {
    const warnings = () => f.repositories.listActivity("agent", "a").filter((e) => e.action === "budget.warning" || e.action === "budget.exhausted");

    await f.repositories.settleRunCost({ runId: "r1", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 100_000 }] }); // 0.50 → crosses 0.5
    assert.deepEqual(warnings().map((e) => (e.summary as { threshold: number }).threshold), [0.5]);

    await f.repositories.settleRunCost({ runId: "r2", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 60_000 }] }); // 0.80 → crosses 0.8
    await f.repositories.settleRunCost({ runId: "r2", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 60_000 }] }); // re-settle: no new event
    assert.deepEqual(warnings().map((e) => (e.summary as { threshold: number }).threshold), [0.5, 0.8], "re-settling does not re-fire a crossed threshold");

    const final = await f.repositories.settleRunCost({ runId: "r3", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 80_000 }] }); // 1.20 → 0.9 + exhausted
    assert.equal(final.exhausted, true);
    const events = warnings();
    assert.deepEqual(events.map((e) => (e.summary as { threshold: number }).threshold), [0.5, 0.8, 0.9, 1]);
    assert.equal(events.filter((e) => e.action === "budget.exhausted").length, 1);
  } finally { await cleanup(f.dir); }
});

test("a spent-at-or-above-budget agent is skipped when claiming the next wakeup", async () => {
  const f = await fixture([{ id: "poor", name: "Poor", budgetLimit: 1 }, { id: "rich", name: "Rich", budgetLimit: 100 }]);
  try {
    await f.repositories.issues.insert({ id: "i1", projectId: "p", identifier: "NX-1", title: "poor", status: "todo", assigneeAgentId: "poor", createdAt: 3, updatedAt: 3 });
    await f.repositories.issues.insert({ id: "i2", projectId: "p", identifier: "NX-2", title: "rich", status: "todo", assigneeAgentId: "rich", createdAt: 3, updatedAt: 3 });
    await f.repositories.settleRunCost({ runId: "spend", agentId: "poor", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 200_000 }] }); // $1.00 == limit
    assert.equal(f.repositories.agentBudgetExhausted("poor"), true);

    await f.repositories.enqueueHeartbeat({ agentId: "poor", issueId: "i1", reason: "assignment", idempotencyKey: "k-poor" });
    await f.repositories.enqueueHeartbeat({ agentId: "rich", issueId: "i2", reason: "assignment", idempotencyKey: "k-rich" });
    const claimed = await f.repositories.claimNextHeartbeat();
    assert.equal(claimed?.wakeup.agentId, "rich", "the over-budget agent is skipped in favour of one under budget");
    assert.equal(await f.repositories.claimNextHeartbeat(), null, "no further claim while the remaining agent is over budget");
  } finally { await cleanup(f.dir); }
});

test("enforceBudget hard-stops in-flight runs for an over-budget agent", async () => {
  const f = await fixture([{ id: "a", name: "Worker", budgetLimit: 1 }]);
  try {
    const runtime = new DurableHeartbeatRuntime(f.repositories, async (_job, context) =>
      new Promise<void>((_resolve, reject) => {
        if (context.signal.aborted) return reject(context.signal.reason);
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      }));
    const job = await runtime.enqueue({ agentId: "a", reason: "invoke", eventId: "e1" });
    const deadline = Date.now() + 2_000;
    while (f.repositories.getHeartbeat(job.heartbeat.id)?.status !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.repositories.getHeartbeat(job.heartbeat.id)?.status, "running");

    assert.deepEqual(await runtime.enforceBudget("a"), [], "an agent under budget is left running");
    await f.repositories.settleRunCost({ runId: "over", agentId: "a", usage: [{ model: HAIKU, inputTokens: 0, outputTokens: 200_000 }] }); // $1.00 == limit
    const cancelled = await runtime.enforceBudget("a");
    assert.deepEqual(cancelled, [job.heartbeat.id]);
    await runtime.runUntilIdle();
    assert.equal(f.repositories.getHeartbeat(job.heartbeat.id)?.status, "cancelled");
    assert.deepEqual(await runtime.enforceBudget("a", "drain"), [], "the drain policy never cancels in-flight work");
    await runtime.shutdown();
  } finally { await cleanup(f.dir); }
});
