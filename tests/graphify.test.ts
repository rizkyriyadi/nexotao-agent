import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// buildWorkGraph reads the SQLite store through the singleton keyed off
// ~/.nexotao (config.DIR), which is captured on first import. Point it at one
// throwaway dir before importing any lib module, then share that db across every
// test in this file (each uses a distinct projectId so writes never collide).
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-graph-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase } = await import("../lib/db/database");
const schema = await import("../lib/db/schema");
const { buildWorkGraph, appendRunToWorkGraph, loadWorkGraph, workGraphPath } = await import("../lib/graphify");

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

test("buildWorkGraph emits task/run/agent nodes and child/blockedBy/references edges", async () => {
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
});

test("buildWorkGraph emits session nodes and memory-link edges from [[slug]] refs", async () => {
  const db = await getDatabase();
  await db.write((d) => d.insert(schema.projects).values({ id: "p3", name: "Sessions", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  // An issue whose summary carries a [[slug]] memory link.
  await db.write((d) => d.insert(schema.issues).values({ id: "i3a", projectId: "p3", identifier: "NEXA-30", title: "Incremental indexing", summary: "Builds on [[nexa-27-graphify]] design.", status: "in_progress", createdAt: 1, updatedAt: 1 }).run());
  // A session that references the issue and links a memory in its messages.
  await db.write((d) => d.insert(schema.sessions).values({ id: "s1", projectId: "p3", title: "Graphify chat", messages: [{ role: "user", content: "How did NEXA-30 go? see [[nexa-27-graphify]]" }], createdAt: 2, updatedAt: 2 }).run());

  const { graph } = await buildWorkGraph("p3");
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  assert.ok(nodeIds.has("session:s1"), "missing session node");
  assert.ok(nodeIds.has("memory:nexa-27-graphify"), "missing memory node");

  const hasEdge = (from: string, to: string, rel: string) => graph.edges.some((e) => e.from === from && e.to === to && e.rel === rel);
  assert.ok(hasEdge("task:NEXA-30", "memory:nexa-27-graphify", "memory-link"), "missing issue->memory link");
  assert.ok(hasEdge("session:s1", "task:NEXA-30", "references"), "missing session->task reference");
  assert.ok(hasEdge("session:s1", "memory:nexa-27-graphify", "memory-link"), "missing session->memory link");
});

test("appendRunToWorkGraph appends one run without a full rebuild and dedupes", async () => {
  const db = await getDatabase();
  await db.write((d) => d.insert(schema.projects).values({ id: "p4", name: "Append", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  await db.write((d) => d.insert(schema.issues).values({ id: "i4", projectId: "p4", identifier: "NEXA-30", title: "Incremental indexing", status: "in_progress", createdAt: 1, updatedAt: 1 }).run());

  // Seed the graph (no runs yet), then append a finished run incrementally.
  await buildWorkGraph("p4");
  const before = await loadWorkGraph("p4");
  assert.ok(!before.nodes.some((n) => n.id === "run:r4"), "run should not exist pre-append");

  const run = { id: "r4", agent: "chief of staff", task: "Ship NEXA-30", summary: "wired append into onIssueFinished; see [[nexa-27-graphify]]", ok: true, ts: 5 };
  const first = await appendRunToWorkGraph("p4", { run, issue: { identifier: "NEXA-30", title: "Incremental indexing", status: "done" } });
  assert.ok(first.appended > 0, "first append should add nodes/edges");

  const afterGraph = await loadWorkGraph("p4");
  const ids = new Set(afterGraph.nodes.map((n) => n.id));
  for (const id of ["run:r4", "agent:chief of staff", "memory:nexa-27-graphify"]) assert.ok(ids.has(id), `missing ${id}`);
  const hasEdge = (from: string, to: string, rel: string) => afterGraph.edges.some((e) => e.from === from && e.to === to && e.rel === rel);
  assert.ok(hasEdge("agent:chief of staff", "run:r4", "touched"), "missing agent->run touched");
  assert.ok(hasEdge("run:r4", "task:NEXA-30", "touched"), "missing run->task touched (from issue + text)");
  assert.ok(hasEdge("run:r4", "memory:nexa-27-graphify", "memory-link"), "missing run->memory link");
  // Degrees stay exact after the incremental merge.
  assert.ok((afterGraph.nodes.find((n) => n.id === "run:r4")!.degree ?? 0) >= 3);

  // Re-appending the same run is a no-op (idempotent dedupe).
  const second = await appendRunToWorkGraph("p4", { run, issue: { identifier: "NEXA-30", title: "Incremental indexing", status: "done" } });
  assert.equal(second.appended, 0, "re-append should add nothing");
  const final = await loadWorkGraph("p4");
  assert.equal(final.nodes.length, afterGraph.nodes.length);
  assert.equal(final.edges.length, afterGraph.edges.length);
});

test("appendRunToWorkGraph seeds a full build when no graph exists yet", async () => {
  const db = await getDatabase();
  await db.write((d) => d.insert(schema.projects).values({ id: "p5", name: "Cold", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
  await db.write((d) => d.insert(schema.issues).values({ id: "i5", projectId: "p5", identifier: "NEXA-30", title: "Incremental indexing", status: "done", createdAt: 1, updatedAt: 1 }).run());
  // The run row exists in the store (addAgentRun ran) but no work.json yet.
  await db.write((d) => d.insert(schema.agentRuns).values({ id: "r5", projectId: "p5", agent: "chief of staff", task: "Ship NEXA-30", summary: "done", ok: true, ts: 5 }).run());

  const seeded = await appendRunToWorkGraph("p5", { run: { id: "r5", agent: "chief of staff", task: "Ship NEXA-30", summary: "done", ok: true, ts: 5 }, issue: { identifier: "NEXA-30", title: "Incremental indexing", status: "done" } });
  assert.equal(seeded.appended, -1, "cold graph should seed via full build");
  const graph = await loadWorkGraph("p5");
  assert.ok(graph.nodes.some((n) => n.id === "run:r5"), "seed build missing the run");
  assert.ok(graph.nodes.some((n) => n.id === "task:NEXA-30"), "seed build missing the task");
});
