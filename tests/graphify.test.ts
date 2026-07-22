import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// buildWorkGraph reads the SQLite store through the singleton keyed off
// ~/.nexotao (config.DIR), so point that at a throwaway dir before importing any
// lib module, then import dynamically so the env is in effect.
test("buildWorkGraph emits task/run/agent nodes and child/blockedBy/references edges", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-graph-"));
  process.env.NEXOTAO_DATA_DIR = dir;
  try {
    const { getDatabase } = await import("../lib/db/database");
    const schema = await import("../lib/db/schema");
    const { buildWorkGraph, workGraphPath } = await import("../lib/graphify");

    const db = await getDatabase();
    await db.write((d) => d.insert(schema.projects).values({ id: "p1", name: "Nexotao", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
    // NEXA-27 (parent) -> NEXA-28 (child, blocked by NEXA-14, references NEXA-14 in text); NEXA-14 done earlier.
    await db.write((d) => d.insert(schema.issues).values({ id: "i1", projectId: "p1", identifier: "NEXA-27", title: "Graphify", status: "in_review", createdAt: 1, updatedAt: 1 }).run());
    await db.write((d) => d.insert(schema.issues).values({ id: "i2", projectId: "p1", identifier: "NEXA-28", parentId: "i1", title: "Graph engine", description: "Reuses the ledger approach from NEXA-14.", status: "in_progress", createdAt: 2, updatedAt: 2 }).run());
    await db.write((d) => d.insert(schema.issues).values({ id: "i3", projectId: "p1", identifier: "NEXA-14", title: "Cost ledger", status: "done", createdAt: 0, updatedAt: 0 }).run());
    await db.write((d) => d.insert(schema.issueDependencies).values({ issueId: "i2", blockerIssueId: "i3", createdAt: 2 }).run());
    await db.write((d) => d.insert(schema.agentRuns).values({ id: "r1", projectId: "p1", agent: "chief of staff", task: "Build the NEXA-28 engine", summary: "wrote lib/graphify.ts", ok: true, ts: 3 }).run());
    // A second project's issue must not leak into p1's graph.
    await db.write((d) => d.insert(schema.projects).values({ id: "p2", name: "Other", path: dir, mode: "single", agentSpecs: [], createdAt: 1 }).run());
    await db.write((d) => d.insert(schema.issues).values({ id: "o1", projectId: "p2", identifier: "OTHER-1", title: "Unrelated", status: "todo", createdAt: 1, updatedAt: 1 }).run());

    const { graph, file } = await buildWorkGraph("p1");

    assert.equal(file, workGraphPath("p1"));
    assert.equal(graph.version, 1);
    assert.equal(graph.projectId, "p1");

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const id of ["task:NEXA-27", "task:NEXA-28", "task:NEXA-14", "run:r1", "agent:chief of staff"]) {
      assert.ok(nodeIds.has(id), `missing node ${id}`);
    }
    assert.ok(!nodeIds.has("task:OTHER-1"), "other project's issue leaked in");

    const hasEdge = (from: string, to: string, rel: string, conf: string) =>
      graph.edges.some((e) => e.from === from && e.to === to && e.rel === rel && e.conf === conf);
    assert.ok(hasEdge("task:NEXA-27", "task:NEXA-28", "child", "EXTRACTED"), "missing child edge");
    assert.ok(hasEdge("task:NEXA-28", "task:NEXA-14", "blockedBy", "EXTRACTED"), "missing blockedBy edge");
    assert.ok(hasEdge("task:NEXA-28", "task:NEXA-14", "references", "EXTRACTED"), "missing references edge");
    assert.ok(hasEdge("agent:chief of staff", "run:r1", "touched", "INFERRED"), "missing agent->run touched edge");
    assert.ok(hasEdge("run:r1", "task:NEXA-28", "touched", "INFERRED"), "missing run->task touched edge");

    // Degrees are populated and no edge dangles or self-loops.
    for (const e of graph.edges) {
      assert.notEqual(e.from, e.to);
      assert.ok(nodeIds.has(e.from) && nodeIds.has(e.to));
    }
    assert.ok((graph.nodes.find((n) => n.id === "task:NEXA-28")!.degree ?? 0) >= 3);

    // work.json is persisted and round-trips.
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.nodes.length, graph.nodes.length);
    assert.equal(persisted.edges.length, graph.edges.length);

    // A project with no history yields an empty graph rather than an error.
    const empty = await buildWorkGraph("no-such-project");
    assert.deepEqual(empty.graph.nodes, []);
    assert.deepEqual(empty.graph.edges, []);

    await db.close();
  } finally {
    delete process.env.NEXOTAO_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
