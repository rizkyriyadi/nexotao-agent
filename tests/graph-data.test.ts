import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the config data dir at a temp location BEFORE importing the module,
// since lib/config resolves DIR from this env var at import time.
const DATA_DIR = await mkdtemp(path.join(tmpdir(), "nexotao-graph-"));
process.env.NEXOTAO_DATA_DIR = DATA_DIR;

const { coerceGraph, mergeGraphs, normalizeGraph, readProjectGraph, workGraphPath } = await import("../lib/graph-data");

test("coerceGraph keeps well-formed nodes/edges and drops junk", () => {
  const g = coerceGraph({
    nodes: [
      { id: "task:NEXA-14", kind: "task", label: "Cost ledger", status: "done", community: 3 },
      { kind: "task", label: "no id — dropped" },
      "not an object",
      { id: "sym:a", label: "a" }, // missing kind → defaults
    ],
    edges: [
      { from: "task:NEXA-14", to: "sym:a", rel: "touched", conf: "INFERRED" },
      { from: "x" }, // missing `to` → dropped
      { from: "task:NEXA-14", to: "sym:a", rel: "uses", conf: "BOGUS" }, // conf coerced to undefined
    ],
  });
  assert.equal(g.nodes.length, 2);
  assert.equal(g.nodes[0].id, "task:NEXA-14");
  assert.equal(g.nodes[1].kind, "node"); // default kind
  assert.equal(g.edges.length, 2);
  assert.equal(g.edges[0].conf, "INFERRED");
  assert.equal(g.edges[1].conf, undefined);
});

test("coerceGraph tolerates missing/garbage input", () => {
  assert.deepEqual(coerceGraph(null), { nodes: [], edges: [], generatedAt: null });
  assert.deepEqual(coerceGraph({}), { nodes: [], edges: [], generatedAt: null });
  assert.deepEqual(coerceGraph({ nodes: "x", edges: 5 }), { nodes: [], edges: [], generatedAt: null });
});

test("normalizeGraph drops dangling edges and recomputes degree", () => {
  const g = normalizeGraph({
    nodes: [
      { id: "a", kind: "task", label: "A", degree: 99 },
      { id: "b", kind: "run", label: "B" },
    ],
    edges: [
      { from: "a", to: "b", rel: "child" },
      { from: "a", to: "ghost", rel: "references" }, // endpoint missing → dropped
    ],
  });
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes.find((n) => n.id === "a")!.degree, 1); // recomputed, not 99
  assert.equal(g.nodes.find((n) => n.id === "b")!.degree, 1);
});

test("mergeGraphs dedupes nodes by id and edges by from/to/rel", () => {
  const a = { nodes: [{ id: "x", kind: "task", label: "X" }], edges: [{ from: "x", to: "y", rel: "child" }], generatedAt: 100 };
  const b = { nodes: [{ id: "x", kind: "task", label: "X dup" }, { id: "y", kind: "run", label: "Y" }], edges: [{ from: "x", to: "y", rel: "child" }, { from: "x", to: "y", rel: "references" }], generatedAt: 200 };
  const m = mergeGraphs(a, b);
  assert.equal(m.nodes.length, 2);
  assert.equal(m.nodes.find((n) => n.id === "x")!.label, "X"); // first wins
  assert.equal(m.edges.length, 2); // child (deduped) + references
  assert.equal(m.generatedAt, 200); // newest
});

test("readProjectGraph returns empty graph when nothing indexed", async () => {
  const g = await readProjectGraph("missing-project");
  assert.deepEqual(g, { nodes: [], edges: [], generatedAt: null });
});

test("readProjectGraph reads and normalizes the work.json", async () => {
  const file = workGraphPath("proj1");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      generatedAt: 1737500000000,
      nodes: [
        { id: "task:NEXA-14", kind: "task", label: "Cost ledger" },
        { id: "run:1", kind: "run", label: "run 1" },
      ],
      edges: [{ from: "task:NEXA-14", to: "run:1", rel: "child", conf: "EXTRACTED" }],
    }),
    "utf8",
  );
  const g = await readProjectGraph("proj1");
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.generatedAt, 1737500000000);
  assert.equal(g.nodes.find((n) => n.id === "task:NEXA-14")!.degree, 1);
});

test.after(async () => { await rm(DATA_DIR, { recursive: true, force: true }); });
