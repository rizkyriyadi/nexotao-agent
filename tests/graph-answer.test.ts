import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// graph-answer reaches the work graph, which resolves its data dir on first
// import. Point it at a throwaway directory and seed a work.json there.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-graphans-"));
process.env.NEXOTAO_DATA_DIR = dir;

const PROJECT = "proj-1";
await mkdir(path.join(dir, "graph", PROJECT), { recursive: true });
await writeFile(
  path.join(dir, "graph", PROJECT, "work.json"),
  JSON.stringify({
    nodes: [
      { id: "task:NEXA-26", label: "Rework approval prompts", kind: "task", status: "done", degree: 1 },
      { id: "run:r1", label: "approval prompt run", kind: "run", degree: 1 },
    ],
    edges: [{ from: "task:NEXA-26", rel: "produced", to: "run:r1", conf: "STATED" }],
  }),
);

const { answerGraphQuery, answerGraphPath, answerGraphExplain } = await import("../lib/graph-answer");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envelope = (data: unknown) => JSON.stringify({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
  isError: false,
});

/** A CLI that is not installed — `code: 127`, exactly as spawnCli reports ENOENT. */
const absent = async () => ({ code: 127, stdout: "", stderr: "" });

/** A CLI that answers each tool from `replies`, and records what was asked. */
function cli(replies: Record<string, unknown>) {
  const calls: string[] = [];
  const exec = async (args: string[]) => {
    const tool = args[args.length - 1];
    calls.push(tool);
    const data = replies[tool];
    if (data === undefined) return { code: 0, stdout: JSON.stringify({ content: [{ type: "text", text: "project not found or not indexed" }], isError: true }), stderr: "" };
    return { code: 0, stdout: envelope(data), stderr: "" };
  };
  return { calls, deps: { exec: exec as any, projectId: PROJECT } };
}

const SYMBOL = {
  name: "evaluateExecutionPolicy", qualified_name: "nexotao-idx-proj-1.lib.execution-policy.evaluateExecutionPolicy",
  label: "Function", file_path: "lib/execution-policy.ts", start_line: 71, end_line: 84,
};

/* ── day one, and every CI run ───────────────────────────────────────────────
 * The code index is optional software nobody has on a fresh install. The graph
 * tools are the *first* call of every run — baseSystem tells every agent to call
 * graph_query before reading files — so "no index" has to read as the answer
 * this app has always given, not as a failure the user cannot act on. */

test("the graph tools answer from work history alone when the index binary is absent", async () => {
  const deps = { exec: absent as any, projectId: PROJECT };
  const query = await answerGraphQuery("approval prompts", "/repo", deps);
  assert.equal(query.ok, true);
  assert.match(query.text, /Rework approval prompts/);
  assert.doesNotMatch(query.text, /Code \(/, "no empty Code heading when there is no code layer");
  assert.doesNotMatch(query.text, /install|binary|codebase-memory/i, "the user is never told about missing software here");

  const explain = await answerGraphExplain("task:NEXA-26", "/repo", deps);
  assert.equal(explain.ok, true);
  assert.equal(explain.display, "task");

  const pathAnswer = await answerGraphPath("task:NEXA-26", "run:r1", "/repo", deps);
  assert.equal(pathAnswer.ok, true);
  assert.match(pathAnswer.text, /produced/);
});

/* ── two answers, never one blended one ──────────────────────────────────────
 * The code index and the work history describe different things — a symbol at a
 * file:line versus a task somebody shipped. Interleaving them would invite the
 * model to treat a task id as a code location. Hence explicit headings. */

test("graph_query labels code symbols and work history as separate answers", async () => {
  const { calls, deps } = cli({ search_graph: { total: 1, results: [SYMBOL] } });
  const answer = await answerGraphQuery("approval", "/repo", deps);

  assert.equal(answer.ok, true);
  assert.ok(calls.includes("search_graph"));
  const code = answer.text.indexOf("Code (1 symbol)");
  const work = answer.text.indexOf("Work history:");
  assert.ok(code >= 0 && work > code, "both sections present, code first");
  assert.match(answer.text, /• evaluateExecutionPolicy {2}Function {2}lib\/execution-policy\.ts:71-84/);
  assert.match(answer.text, /Rework approval prompts/);
  assert.equal(answer.display, "1 symbols · 2 nodes");
});

/* ── the work graph keeps its inputs ─────────────────────────────────────────
 * graph_path already answers questions about task ids today. Consulting the call
 * graph first would change those answers; consulting it second can only add. */

test("graph_path prefers the work-history path and falls back to the call graph", async () => {
  const trace = {
    function: "evaluateExecutionPolicy",
    callers: [{ name: "authorizeTool", qualified_name: "x.lib.execution-policy.authorizeTool", hop: 1 }],
    callees: [],
  };

  // Two nodes the work graph knows about: answered exactly as before, and the
  // code index is never even consulted.
  const known = cli({ trace_path: trace });
  const workPath = await answerGraphPath("task:NEXA-26", "run:r1", "/repo", known.deps);
  assert.match(workPath.text, /Path \(1 hop/);
  assert.equal(workPath.display, "1 hops");
  assert.deepEqual(known.calls, [], "an answerable work-history path spawns no indexer");

  // Two symbols it does not: the call graph answers, and says how they connect.
  const fallback = cli({ trace_path: trace });
  const codePath = await answerGraphPath("evaluateExecutionPolicy", "authorizeTool", "/repo", fallback.deps);
  assert.ok(fallback.calls.includes("trace_path"));
  assert.match(codePath.text, /"authorizeTool" is reached from "evaluateExecutionPolicy" in 1 hop/);
  assert.equal(codePath.display, "1 hops (calls)");

  // A symbol that is genuinely unreachable says so rather than implying a link.
  const miss = cli({ trace_path: trace });
  const none = await answerGraphPath("evaluateExecutionPolicy", "somethingElse", "/repo", miss.deps);
  assert.match(none.text, /does not appear within 1 call-graph hop/);
  assert.equal(none.display, "no path");
});

/* ── the payload that lands in the model's context ───────────────────────────
 * A tool result is re-serialized on every subsequent turn of a run, so an
 * uncapped source body is paid for up to sixty times. read_file caps at the same
 * boundary with the same marker (lib/tools.ts:154). */

test("graph_explain describes a symbol when no work-history node matches", async () => {
  const { calls, deps } = cli({
    get_code_snippet: {
      ...SYMBOL, source: "export function evaluateExecutionPolicy() { return 'allow'; }",
      complexity: 3, cognitive: 1, callers: 2, callees: 0, signature: "(policy, details) => Decision",
    },
  });
  const answer = await answerGraphExplain("evaluateExecutionPolicy", "/repo", deps);

  assert.equal(answer.ok, true);
  assert.ok(calls.includes("get_code_snippet"));
  assert.equal(answer.display, "Function");
  assert.match(answer.text, /lib\/execution-policy\.ts:71-84/);
  assert.match(answer.text, /complexity 3, cognitive 1, 2 caller\(s\), 0 callee\(s\)/);
  assert.match(answer.text, /export function evaluateExecutionPolicy/);

  // A work-history node still wins the id namespace outright.
  const byId = cli({ get_code_snippet: SYMBOL });
  const node = await answerGraphExplain("task:NEXA-26", "/repo", byId.deps);
  assert.equal(node.display, "task");
  assert.deepEqual(byId.calls, [], "a resolved work-history node spawns no indexer");

  // A long body is capped, and says that it was.
  const long = cli({ get_code_snippet: { ...SYMBOL, source: "x".repeat(10_000) } });
  const capped = await answerGraphExplain("evaluateExecutionPolicy", "/repo", long.deps);
  assert.ok(capped.text.length < 6_000, `capped, got ${capped.text.length}`);
  assert.match(capped.text, /… \(truncated\)$/);

  // Nothing anywhere reads as "not found", not as an error.
  const nothing = cli({});
  const missing = await answerGraphExplain("noSuchThing", "/repo", nothing.deps);
  assert.equal(missing.display, "not found");
});

/* ── one shape for one location ──────────────────────────────────────────────
 * search_graph reports file paths relative to the repo; get_code_snippet reports
 * them absolute. An agent that reads `/home/someone/code/app/lib/x.ts` from one
 * tool and `lib/x.ts` from another will eventually paste the first into a file
 * it writes — a path that exists on exactly one machine. */

test("code locations are reported relative to the repo, whichever tool answered", async () => {
  const repo = process.cwd();
  const { deps } = cli({
    get_code_snippet: { ...SYMBOL, file_path: `${repo}/lib/execution-policy.ts`, source: "x" },
  });
  const answer = await answerGraphExplain("evaluateExecutionPolicy", repo, deps);
  assert.match(answer.text, /(?<!\/)lib\/execution-policy\.ts:71-84/);
  assert.ok(!answer.text.includes(`${repo}/lib`), "no absolute path reaches the model");
});
