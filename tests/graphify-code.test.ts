import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// graphify-code imports lib/graphify, which resolves its data dir (config.DIR)
// from the environment on first import. Point it at a throwaway dir before
// importing any lib module so refreshCodeGraph writes there, not into ~/.nexotao.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-codegraph-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { detectGraphify, ensureGraphify, buildCodeGraph, normalizeGraphifyGraph, refreshCodeGraph, GRAPHIFY_PACKAGE } =
  await import("../lib/graphify-code");
const { loadWorkGraph, codeGraphPath } = await import("../lib/graphify");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A fake exec that reports graphify as absent (command not found).
const absentExec = async () => ({ code: 127, output: "graphify: command not found" });

test("detectGraphify is false and buildCodeGraph no-ops when graphify is absent", async () => {
  assert.equal(await detectGraphify(absentExec as any), false);
  // No throw, no prompt, no install — a clean null.
  assert.equal(await buildCodeGraph(process.cwd(), { exec: absentExec as any }), null);
});

test("ensureGraphify does not install unless explicitly opted in", async () => {
  const calls: string[] = [];
  const exec = async (cmd: string) => {
    calls.push(cmd);
    return { code: cmd.includes("--version") ? 127 : 0, output: "" };
  };
  // autoInstall defaults false → never runs pip.
  assert.equal(await ensureGraphify({ exec: exec as any }), false);
  assert.ok(!calls.some((c) => c.includes("pip install")), "must not pip install without opt-in");
  assert.equal(GRAPHIFY_PACKAGE, "graphifyy");
});

test("buildCodeGraph swallows a broken/failed graphify run (graceful no-op)", async () => {
  const flakyExec = async (cmd: string) =>
    cmd.includes("--version") ? { code: 0, output: "graphify 8.0" } : { code: 1, output: "boom" };
  assert.equal(await buildCodeGraph(process.cwd(), { exec: flakyExec as any }), null);
});

test("normalizeGraphifyGraph maps graphify graph.json into the superset schema", () => {
  const g = normalizeGraphifyGraph({
    nodes: [{ id: "get_request_handler", type: "function", file: "app.py", line: 12, community: 1, degree: 4 }],
    edges: [{ from: "get_request_handler", to: "ModelField", type: "references", confidence: "EXTRACTED" }],
  });
  assert.equal(g.nodes[0].id, "code:get_request_handler");
  assert.equal(g.nodes[0].kind, "function");
  assert.equal(g.nodes[0].source, "app.py:12");
  assert.deepEqual(g.edges[0], { from: "code:get_request_handler", to: "code:ModelField", rel: "references", conf: "EXTRACTED" });
});

test("normalizeGraphifyGraph tolerates the links/source/target variant and missing fields", () => {
  const g = normalizeGraphifyGraph({
    nodes: [{ name: "Foo" }],
    links: [{ source: "Foo", target: "Bar" }],
  });
  assert.equal(g.nodes[0].id, "code:Foo");
  assert.equal(g.nodes[0].kind, "symbol"); // default kind
  assert.equal(g.nodes[0].source, undefined); // no file → no source
  assert.deepEqual(g.edges[0], { from: "code:Foo", to: "code:Bar", rel: "references", conf: undefined });
});

test("refreshCodeGraph persists the code graph and loadWorkGraph merges it with work history", async () => {
  // A fake project root holding a graphify-out/graph.json, plus an exec that
  // reports graphify present and its build succeeding.
  const root = await mkdtemp(path.join(tmpdir(), "nexotao-proj-"));
  await mkdir(path.join(root, "graphify-out"), { recursive: true });
  await writeFile(
    path.join(root, "graphify-out", "graph.json"),
    JSON.stringify({
      nodes: [{ id: "handleRun", kind: "function", file: "lib/executor.ts", line: 107 }],
      edges: [{ from: "handleRun", to: "createRun", rel: "calls" }],
    }),
  );
  const presentExec = async (cmd: string) => ({ code: 0, output: cmd.includes("--version") ? "graphify 8.0" : "built" });

  const count = await refreshCodeGraph("proj-x", root, { exec: presentExec as any });
  assert.equal(count, 1);

  // Persisted at the shared code-graph path the UI reader also loads from.
  const persisted = JSON.parse(await readFile(codeGraphPath("proj-x"), "utf8"));
  assert.equal(persisted.nodes[0].id, "code:handleRun");

  // The core acceptance criterion: graph_query/path/explain (via loadWorkGraph)
  // now see the code nodes merged into the queryable graph.
  const merged = await loadWorkGraph("proj-x");
  assert.ok(merged.nodes.some((n) => n.id === "code:handleRun"), "code node must merge into the queried graph");
  assert.ok(merged.edges.some((e) => e.from === "code:handleRun" && e.rel === "calls"));

  await rm(root, { recursive: true, force: true });
});

test("no bundled Python: package.json declares no Python tooling and ships no lib/Python in files", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const depKeys = Object.keys(pkg.dependencies ?? {});
  assert.ok(!depKeys.some((k) => /graphif|python|pip/i.test(k)), "no Python/graphify runtime dependency may be bundled");
  const files: string[] = pkg.files ?? [];
  assert.ok(!files.some((f) => /python|graphify/i.test(f)), "published files must not include Python/graphify assets");
});
