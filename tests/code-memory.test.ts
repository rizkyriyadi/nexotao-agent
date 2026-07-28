import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// code-memory reaches lib/store (for the cache sweep) which resolves its data
// dir on first import. Point it at a throwaway directory before importing.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-codemem-"));
process.env.NEXOTAO_DATA_DIR = dir;

const {
  parseCliOutput, codeIndexName, indexProject, refreshCodeIndex, resetCodeIndexCaches,
  searchCode, traceCode, explainCode, dropCodeIndex, detectCodeMemory, sweepCodeIndexCache,
  canonicalRoot, codeIndexCacheDir, installCodeMemory, resetInstallState,
  INDEX_PREFIX, CLI_PACKAGE, INSTALL_COMMAND, TOOLS_DIR,
} = await import("../lib/code-memory");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Wrap a payload the way the CLI does: text content plus structuredContent. */
const envelope = (data: unknown, isError = false) => JSON.stringify({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
  isError,
});

/** A CLI that is not installed. `code: 127`, exactly as spawnCli reports ENOENT. */
const absent = async () => ({ code: 127, stdout: "", stderr: "" });

/** Records every invocation so a test can assert on what was actually spawned. */
function recorder(reply: (tool: string, input: any) => string) {
  const calls: { args: string[]; stdin: string }[] = [];
  const exec = async (args: string[], stdin: string) => {
    calls.push({ args, stdin });
    const tool = args[args.length - 1];
    return { code: 0, stdout: reply(tool, stdin ? JSON.parse(stdin) : {}), stderr: "" };
  };
  return { calls, exec: exec as any };
}

/* ── day one, and every CI run ───────────────────────────────────────────────
 * The binary is optional and absent on a fresh install. `graph_query` is the
 * first call of every run — an error there is the first thing the user sees, and
 * there is nothing they could do about it. So "absent" must be indistinguishable
 * from "this project has no code layer", never from "something broke". */

test("every code-index call degrades to nothing when the binary is absent", async () => {
  resetCodeIndexCaches();
  const deps = { exec: absent as any };
  assert.equal(await detectCodeMemory(deps), false);
  assert.equal(await indexProject("p", process.cwd(), deps), null);
  assert.equal(await searchCode("p", "anything", 5, deps), null);
  assert.equal(await traceCode("p", "someFn", deps), null);
  assert.equal(await explainCode("p", "someFn", deps), null);
  assert.equal(await dropCodeIndex("p", deps), false);
});

/* ── narration on the wrong stream ───────────────────────────────────────────
 * `level=…` lines are documented to go to stderr, but they have been observed
 * interleaved with stdout during indexing. A bare JSON.parse of a narrated
 * stream throws, and the caller then reports "no results" from an index that is
 * perfectly healthy — the worst kind of failure, because it looks like an
 * answer. */

test("log narration mixed into the output stream never reaches the parsed payload", () => {
  const stdout = [
    "level=info msg=index.supervisor.reap workers=4",
    envelope({ results: [{ name: "alpha" }] }),
    "level=warn msg=cache.lock retry=1",
  ].join("\n");
  const parsed = parseCliOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal((parsed.data as any).results[0].name, "alpha");
});

/* ── the cold start that looks like success ──────────────────────────────────
 * Querying a project that was never indexed returns `isError: true` with **exit
 * code 0**. An exit-code-only check calls that success and hands the error text
 * back as data — so an agent's first graph_query would quote "project not found"
 * as if it were a finding. */

test("a project that was never indexed reads as an empty code layer, not a failure", async () => {
  const exec = async () => ({
    code: 0,
    stdout: JSON.stringify({ content: [{ type: "text", text: "project not found or not indexed" }], isError: true }),
    stderr: "",
  });
  const parsed = parseCliOutput(await exec().then((r) => r.stdout));
  assert.equal(parsed.ok, false);
  assert.match(String(parsed.error), /not indexed/);
  // And the public surface turns that into "no code layer", not a throw.
  assert.equal(await searchCode("p", "q", 5, { exec: exec as any }), null);
});

/* ── one index per project, whatever tree the run is in ──────────────────────
 * Every lead-execute run works in a throwaway git worktree. Indexing that path
 * would register a project keyed by a directory deleted minutes later: one dead
 * multi-MB index per run, accumulating forever in a cache directory the user was
 * never told about. */

test("a run indexes its project's canonical repo, never the worktree it executes in", async () => {
  resetCodeIndexCaches();
  const rec = recorder(() => envelope({ project: codeIndexName("p1"), nodes: 12, edges: 30 }));
  const worktree = "/home/u/.nexotao/worktrees/abc123/nx-12-9b7ddca6";
  // Stand in for git: the worktree's --git-common-dir points at the owning repo.
  const git = async () => ({ code: 0, stdout: "/home/u/code/my-app/.git\n", stderr: "" });
  const canonical = await canonicalRoot(worktree, { exec: git as any });
  assert.equal(canonical, "/home/u/code/my-app");

  const status = await indexProject("p1", worktree, { exec: rec.exec });
  assert.equal(status?.nodes, 12);
  const sent = JSON.parse(rec.calls[0].stdin);
  assert.equal(sent.repo_path, "/home/u/code/my-app");
  assert.equal(sent.name, `${INDEX_PREFIX}p1`);
  assert.ok(!rec.calls[0].stdin.includes("worktrees"), "the worktree path must not reach the indexer");
});

/* ── two indexers, one SQLite file ───────────────────────────────────────────
 * The triggers deliberately overlap: opening a project and starting a run fire
 * within moments of each other. Two concurrent index passes over one database is
 * how the `.db.corrupt` file in the shared cache got there. */

test("a burst of refreshes coalesces into a single indexer", async () => {
  resetCodeIndexCaches();
  const rec = recorder(() => envelope({ project: codeIndexName("p2"), nodes: 5, edges: 5 }));
  const all = await Promise.all(
    Array.from({ length: 5 }, () => refreshCodeIndex("p2", "/repo", { exec: rec.exec })),
  );
  assert.equal(rec.calls.length, 1, "five concurrent refreshes must spawn one indexer");
  for (const status of all) assert.equal(status?.nodes, 5);

  // A call arriving right after the burst is still inside the debounce window.
  await refreshCodeIndex("p2", "/repo", { exec: rec.exec });
  assert.equal(rec.calls.length, 1);
  // …but one past the window does real work again.
  await refreshCodeIndex("p2", "/repo", { exec: rec.exec, minIntervalMs: 0 });
  assert.equal(rec.calls.length, 2);
});

/* ── nothing this module parses may throw ───────────────────────────────────── */

test("parseCliOutput never throws, whatever the process wrote", () => {
  const cases = [
    "", "   ", "level=info msg=only-narration", "{", "null", "[]", "not json at all",
    JSON.stringify({ content: [] }),
    envelope({ ok: 1 }),
    envelope("boom", true),
    `${envelope({ results: [] })}\n{ truncated`,
    JSON.stringify({ content: [{ type: "text", text: "x".repeat(3_000_000) }] }),
  ];
  for (const c of cases) {
    const r = parseCliOutput(c);
    assert.equal(typeof r.ok, "boolean", `parse must return a result for: ${c.slice(0, 30)}`);
    if (!r.ok) assert.equal(r.data, null);
  }
  // The healthy case still resolves to the payload, not to a tolerated failure.
  assert.deepEqual(parseCliOutput(envelope({ ok: 1 })).data, { ok: 1 });
});

test("query results are normalized into the shapes the graph tools render", async () => {
  const rec = recorder((tool) => {
    if (tool === "search_graph") return envelope({ total: 1, results: [
      { name: "evaluateExecutionPolicy", qualified_name: "x.lib.execution-policy.evaluateExecutionPolicy", label: "Function", file_path: "lib/execution-policy.ts", start_line: 71, end_line: 84 },
    ] });
    if (tool === "trace_path") return envelope({ function: "evaluateExecutionPolicy", callers: [
      { name: "authorizeTool", qualified_name: "x.lib.execution-policy.authorizeTool", hop: 1 },
    ], callees: [] });
    return envelope({
      name: "evaluateExecutionPolicy", qualified_name: "x.lib.execution-policy.evaluateExecutionPolicy",
      label: "Function", file_path: "lib/execution-policy.ts", start_line: 71, end_line: 84,
      source: "export function evaluateExecutionPolicy() {}", complexity: 3, callers: 2, callees: 0,
    });
  });
  const hits = await searchCode("p", "approval", 5, { exec: rec.exec });
  assert.deepEqual(hits?.[0], { name: "evaluateExecutionPolicy", kind: "Function", file: "lib/execution-policy.ts", startLine: 71, endLine: 84 });

  const trace = await traceCode("p", "evaluateExecutionPolicy", { exec: rec.exec });
  assert.equal(trace?.hops[0].name, "authorizeTool");
  assert.equal(trace?.hops[0].direction, "caller");

  const snippet = await explainCode("p", "evaluateExecutionPolicy", { exec: rec.exec });
  assert.equal(snippet?.file, "lib/execution-policy.ts");
  assert.equal(snippet?.complexity, 3);
});

/* ── the cache is not ours alone ─────────────────────────────────────────────
 * ~/.cache/codebase-memory-mcp holds indexes the user built by hand for their own
 * CLI use, and (observed on a real machine) a directory belonging to unrelated
 * tooling. Reclaiming disk is worth far less than deleting one of those, so the
 * sweep only ever touches files carrying our own prefix. */

test("the cache sweep removes only our orphaned indexes, never a stranger's", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "nexotao-cache-"));
  const now = Date.now();
  const week = 7 * 24 * 60 * 60_000;
  const put = async (name: string, ageMs = 0) => {
    const file = path.join(sandbox, name);
    await writeFile(file, "x");
    if (ageMs) await utimes(file, (now - ageMs) / 1000, (now - ageMs) / 1000);
    return file;
  };
  try {
    const alive = await put(`${INDEX_PREFIX}live.db`);          // ours, project still exists
    const orphan = await put(`${INDEX_PREFIX}gone.db`);         // ours, project deleted
    const orphanWal = await put(`${INDEX_PREFIX}gone.db-wal`);
    const stranger = await put("srv-nexotao-apps-agent.db");    // the user's own CLI index
    const fresh = await put("srv-nexotao-apps-agent.db.corrupt", 60_000);
    const stale = await put("old-project.db.corrupt", week + 60_000);
    await mkdir(path.join(sandbox, "nexotao-refresh"), { recursive: true });
    await writeFile(path.join(sandbox, "nexotao-refresh", "marker"), "x");

    const { removed } = await sweepCodeIndexCache({ knownProjectIds: ["live"], now, dir: sandbox });
    assert.equal(removed, 3, "the orphan, its -wal, and the week-old corruption");

    const gone = async (f: string) => !(await stat(f).then(() => true, () => false));
    assert.ok(await gone(orphan), "our orphaned index is reclaimed");
    assert.ok(await gone(orphanWal), "and its sidecar with it");
    assert.ok(await gone(stale), "week-old corruption is unreadable by anyone");
    for (const keep of [alive, stranger, fresh]) assert.ok(!(await gone(keep)), `must survive: ${path.basename(keep)}`);
    // A directory belonging to unrelated tooling is never a candidate.
    assert.ok(!(await gone(path.join(sandbox, "nexotao-refresh", "marker"))));

    // A cache directory that does not exist yet is not an error.
    assert.deepEqual(await sweepCodeIndexCache({ knownProjectIds: [], dir: path.join(sandbox, "nope") }), { removed: 0 });
    assert.ok(codeIndexCacheDir().includes(CLI_PACKAGE));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

/* ── the payload the user actually downloads ─────────────────────────────────
 * Ported from the deleted graphify-code suite. The hazard only changed shape: a
 * Python runtime became a ~258 MB binary. `optionalDependencies` would not save
 * us — npm installs those by default, so every `npm i -g nexotao` would pull it. */

test("the published package pulls in no code-index runtime", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
  assert.ok(!deps.some((k) => /graphif|python|pip|codebase-memory/i.test(k)), "no code-index runtime may be bundled");
  const files: string[] = pkg.files ?? [];
  assert.ok(!files.some((f) => /python|graphify|codebase-memory/i.test(f)), "published files must not ship an index binary");
});

/* ── a quarter of a gigabyte, on purpose ─────────────────────────────────────
 * The install downloads ~37 MB and unpacks ~258 MB onto the user's machine. That
 * is fine when they asked for it and unacceptable as a side effect of anything
 * else, so confirmation is required at the route and the spawn is single-flight:
 * a double-clicked button running two npm processes over one node_modules is how
 * a half-written install happens. */

test("installing the code index is single-flight and never throws", async () => {
  resetInstallState();
  let spawns = 0;
  const slow = async () => { spawns += 1; await new Promise((r) => setTimeout(r, 30)); return { code: 0, stdout: "added 1 package", stderr: "" }; };
  const both = await Promise.all([installCodeMemory({ exec: slow as any }), installCodeMemory({ exec: slow as any })]);
  assert.equal(spawns, 1, "a double click must not start two installs");
  for (const r of both) assert.equal(r.ok, true);

  // A failed install reports npm's own last words rather than throwing, because
  // that output is the only thing that helps anyone.
  resetInstallState();
  const failing = async () => ({ code: 1, stdout: "", stderr: "npm ERR! code EACCES\nnpm ERR! syscall mkdir" });
  const failed = await installCodeMemory({ exec: failing as any });
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /EACCES/);

  // …and an exec that blows up entirely is still just a failed install.
  resetInstallState();
  const exploding = async () => { throw new Error("spawn ENOMEM"); };
  assert.equal((await installCodeMemory({ exec: exploding as any })).ok, false);

  // The command offered to the user is the one actually run, into a prefix that
  // needs no privileges — `npm i -g` would need sudo on a root-owned prefix.
  assert.match(INSTALL_COMMAND, new RegExp(`^npm install --prefix ${TOOLS_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
  assert.ok(INSTALL_COMMAND.endsWith(CLI_PACKAGE));
  assert.ok(!INSTALL_COMMAND.includes(" -g"), "a global install would need sudo");
});
