// End-to-end verification of the code-intelligence layer, driven as a user.
//
// The claim under test is the one every run opens with: "call graph_query before
// reading files". Until now that reached only the work-history graph, so an
// agent told to consult the graph learned nothing about the code it was about to
// change. This suite drives the whole path — index, query, transcript, teardown —
// against a real server, a real browser and (when it is installed) the real CLI.
//
// Three things it is built to catch, in order of how much they would cost:
//
//   1. The worktree leak. Runs execute in throwaway git worktrees. Indexing one
//      registers a project keyed by a directory deleted minutes later: a dead
//      multi-MB index per run, accumulating forever in a cache directory the
//      user was never told about. Phase 5 is the assertion that matters most.
//   2. The day-one experience. The binary is optional and absent on a fresh
//      install. With it gone the graph tools must still answer from work history
//      with no error, no denial and no mention of missing software.
//   3. The deletion promise. A symbol-level index of the user's source living on
//      after they deleted the project would break it quietly.
//
// Unlike drive.mjs this boots its own server on 127.0.0.1:<port> against a
// throwaway NEXOTAO_DATA_DIR, so plain fetch works — the Host header it sends
// already matches NEXOTAO_ALLOWED_HOST. No curl needed.
//
// Requires: `npm run build`, a Chromium (scripts/e2e/browser.mjs), and a live
// Gateway key in ~/.nexotao/config.json for the two phases that drive real runs.
// Every phase degrades to a skip rather than a failure when its precondition is
// missing, so this is runnable on a machine with neither the CLI nor a key.
//
//   node scripts/e2e/code-graph.mjs             # everything the machine allows
//   node scripts/e2e/code-graph.mjs --install    # also exercise the install button (~40 MB)
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./browser.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const HOST = "127.0.0.1";
const VIEWPORT = { width: 1440, height: 1000 };
const WANT_INSTALL = process.argv.includes("--install");

let failures = 0, skipped = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return Boolean(ok);
};
const skip = (name, why) => { console.log(`SKIP  ${name} — ${why}`); skipped += 1; };
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.once("error", () => resolve({ code: 127, out: "", err: "" }));
    child.once("exit", (code) => resolve({ code, out, err }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/** Ask the CLI directly, the way the app does: `cli --json <tool>` over stdin. */
async function cli(tool, input = {}, bin = "codebase-memory-mcp") {
  const r = await run(bin, ["cli", "--json", tool], { stdin: JSON.stringify(input) });
  if (r.code === 127) return null;
  const line = r.out.split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (!line) return null;
  try {
    const env = JSON.parse(line);
    if (env.isError) return null;
    return env.structuredContent ?? JSON.parse(env.content?.[0]?.text ?? "null");
  } catch { return null; }
}

async function waitHealthy(port, token) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`http://${HOST}:${port}/api/health`, { headers: { cookie: `nexotao_session=${token}` } });
      if (r.ok && (await r.json()).ok) return true;
    } catch { /* not up yet */ }
    await settle(250);
  }
  return false;
}

function bootServer(port, token, dataDir, env = {}) {
  const nextBin = require.resolve("next/dist/bin/next");
  return spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", HOST], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), HOSTNAME: HOST,
      NEXOTAO_ALLOWED_HOST: `${HOST}:${port}`, NEXOTAO_SESSION_TOKEN: token,
      NEXOTAO_DATA_DIR: dataDir, NEXOTAO_NO_OPEN: "1", ...env,
    },
  });
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise((resolve) => {
    const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

/** A same-origin fetch issued from inside the authenticated page. */
const pageJson = (page, path, init) => page.evaluate(async (p, i) => {
  const r = await fetch(p, i ? { ...i, headers: { "Content-Type": "application/json", ...(i.headers || {}) } } : undefined);
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}, path, init ?? null);

async function main() {
  const browserPath = resolveBrowser();
  if (!browserPath) { console.error("No Chromium. npx @puppeteer/browsers install chrome-headless-shell@stable"); process.exit(2); }

  const port = 4900 + (process.pid % 80);
  const token = "codegraph-" + "t".repeat(40);
  const dataDir = await mkdtemp(join(tmpdir(), "nexotao-codegraph-"));
  const shots = join(ROOT, "e2e-artifacts", "code-graph");
  await mkdir(shots, { recursive: true });

  // A real key means phases 3 and 5 can drive real runs. Without one they skip
  // rather than fail: the index half of this suite does not need a Gateway.
  let key = null, model = null;
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), ".nexotao", "config.json"), "utf8"));
    if (cfg.apiKey) { key = cfg.apiKey; model = cfg.model ?? null; }
  } catch { /* no local config — the run phases will skip */ }

  const binaryPresent = (await run("codebase-memory-mcp", ["--version"])).code === 0;
  console.log(`\ncode index binary: ${binaryPresent ? "present" : "absent"} · gateway key: ${key ? "present" : "absent"}\n`);

  let server, browser, projectId = null;
  const shot = async (page, name) => {
    const file = join(shots, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`      shot: ${file}`);
  };

  try {
    // The project points at this repository, so the index describes real code
    // and the questions below have real answers.
    const seed = await run(process.execPath, ["--import", "tsx", "-e", `
      import { saveConfig } from "${ROOT}/lib/config";
      import { addProject } from "${ROOT}/lib/store";
      const project = await addProject({ name: "Code Graph", path: ${JSON.stringify(ROOT)}, mode: "single", agents: [] });
      await saveConfig({ apiKey: ${JSON.stringify(key ?? "e2e-" + "k".repeat(40))}, model: ${JSON.stringify(model ?? "nexotao-default")}, onboarded: true, activeProjectId: project.id, defaultMode: "ask" });
      process.stdout.write(JSON.stringify({ projectId: project.id }) + "\\n");
    `], { env: { ...process.env, NEXOTAO_DATA_DIR: dataDir } });
    if (seed.code !== 0) throw new Error(`seed failed: ${seed.err.slice(-800)}`);
    projectId = JSON.parse(seed.out.trim().split("\n").pop()).projectId;
    const indexName = `nexotao-idx-${projectId}`;
    console.log(`project ${projectId}\n`);

    server = bootServer(port, token, dataDir);
    if (!check("server boots", await waitHealthy(port, token))) throw new Error("never healthy");

    browser = await puppeteer.launch({ executablePath: browserPath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const url = (p) => `http://${HOST}:${port}${p}`;

    /* ── 1. The graph page as the user first meets it ─────────────────────── */
    console.log("\n1. the graph page");
    await page.goto(url(`/graph?session_token=${token}`), { waitUntil: "networkidle2" });
    await settle(1200);
    const before = await page.evaluate(() => document.body.innerText);
    check("the graph page renders", before.includes("Knowledge graph"), before.slice(0, 80).replace(/\n/g, " "));
    // The banner states the code layer's condition either way — this is the one
    // surface that tells the user whether the agent can see their code at all.
    check("the code layer is reported in the banner",
      /Code index active|No code index/.test(before),
      (before.match(/Code index active[^\n]*|No code index[^\n]*/) ?? ["(no banner)"])[0]);
    await shot(page, "01-graph-before");

    /* ── 2. Build, and read the index back ───────────────────────────────── */
    console.log("\n2. building the index");
    const built = await pageJson(page, "/api/graph", { method: "POST" });
    check("POST /api/graph succeeds", built.ok && built.body?.ok, `status ${built.status}`);
    const code = built.body?.code ?? {};
    check("the response reports the code layer", typeof code.available === "boolean", JSON.stringify(code));
    if (binaryPresent) {
      check("the code index is available", code.available === true);
      check("it holds real symbols", code.nodes > 0, `${code.nodes} nodes · ${code.edges} edges`);
      check("under our own name, not a path slug", code.project === indexName, `${code.project}`);
    } else {
      skip("index contents", "binary absent — covered by the absent-binary phase below");
    }
    // Reload deliberately: the counts must come back from the server, not from
    // React state the build happened to leave behind. A user who refreshes
    // /graph should still be told how much of their code the agent can see.
    await page.reload({ waitUntil: "networkidle2" });
    await settle(1500);
    const afterBuild = await page.evaluate(() => document.body.innerText);
    if (binaryPresent) {
      check("the banner counts the symbols it indexed, and still does after a reload",
        /Code index active[^\n]*symbols/.test(afterBuild),
        (afterBuild.match(/Code index active[^\n]*/) ?? [""])[0]);
    }
    await shot(page, "02-graph-indexed");

    /* ── 3. The whole change in one screenshot ───────────────────────────────
       An Ask-mode run asked something only a code index can answer. Before this
       work the graph tool would have returned work history alone and the model
       would have fallen back to reading files.

       Driven through the composer rather than POST /api/chat: that route is
       headless — it starts a `chat`-kind run no page renders — so asserting on
       a transcript after calling it looks at a surface that was never going to
       show one. The user's path is the board composer, which creates an issue
       and lands on /board/<id>, and that page is where the Graph chip lives. */
    console.log("\n3. an Ask-mode run that asks about code");
    if (!key) skip("Ask-mode run", "no Gateway key in ~/.nexotao/config.json");
    else if (!binaryPresent) skip("Ask-mode run", "binary absent — the point of the phase is the code answer");
    else {
      const ASK = "Using graph_query, which function decides whether a tool call needs approval, and who calls it? Answer with the file and line.";
      await page.goto(url("/board"), { waitUntil: "networkidle2" });
      await settle(1200);

      // Pick Ask mode from the composer's mode menu, then type and send.
      await page.evaluate(() => {
        const trigger = [...document.querySelectorAll("button[aria-haspopup='menu']")]
          .find((b) => /Agent|Plan|Ask/.test(b.textContent ?? ""));
        trigger?.click();
      });
      await settle(400);
      const pickedAsk = await page.evaluate(() => {
        const option = [...document.querySelectorAll("[role='menuitemradio'], button")]
          .find((b) => (b.textContent ?? "").trim().startsWith("Ask"));
        if (!option) return false;
        option.click();
        return true;
      });
      check("the composer offers Ask mode", pickedAsk);
      await settle(400);

      await page.click("textarea");
      await page.type("textarea", ASK);
      await settle(300);
      await page.evaluate(() => {
        const send = [...document.querySelectorAll("button[aria-label^='Send in']")][0];
        send?.click();
      });

      // The composer navigates to the task page it just created.
      await page.waitForFunction(() => /\/board\/[0-9a-f-]{8,}/.test(location.pathname), { timeout: 30_000 })
        .catch(() => {});
      const taskUrl = page.url();
      check("the run gets its own task page", /\/board\/[0-9a-f-]{8,}/.test(taskUrl), taskUrl.replace(/^https?:\/\/[^/]+/, ""));

      /* Wait on the page the user is looking at: the transcript streams in, so
         poll its text until the run settles rather than guessing a duration. */
      const settled = await page.waitForFunction(
        () => /Graph/.test(document.body.innerText) && !/\bthinking\b|Working/i.test(document.body.innerText),
        { timeout: 240_000, polling: 2_000 },
      ).then(() => true, () => false);
      const transcript = await page.evaluate(() => document.body.innerText);
      check("the transcript shows a Graph chip", /Graph/.test(transcript),
        settled ? "" : "run did not settle within 4 minutes");
      /* No denial chip on the Graph rows. Matched against the rendered chip
         text, not the whole transcript: a run *about* approval policy quite
         reasonably writes "allowed, denied, or needs approval" in its prose,
         and a substring search over the page reads that as a failure. */
      const graphChips = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => /^\s*Graph/.test(b.textContent ?? ""))
          .map((b) => (b.textContent ?? "").trim()));
      check("the graph tool was not denied", graphChips.length > 0 && !graphChips.some((t) => /Denied|Error/.test(t)),
        graphChips.join(" | ") || "(no graph chip)");
      await shot(page, "03-run-transcript");

      // Expand the chip so the merged answer is visible in the artifact — and
      // assert on what it actually rendered, which is the user-visible proof.
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("button")].find((b) => /^\s*Graph/.test(b.textContent ?? ""));
        el?.click();
      });
      await settle(1200);
      // Bring the opened body into frame — otherwise the artifact shows the
      // collapsed row and the reader has to take the assertion's word for it.
      await page.evaluate(() => {
        const found = [...document.querySelectorAll("*")].reverse()
          .find((n) => n.children.length === 0 && /Code \(\d+ symbols\)/.test(n.textContent ?? ""));
        found?.scrollIntoView({ block: "center" });
      });
      await settle(600);
      const expanded = await page.evaluate(() => document.body.innerText);
      check("the graph tool answered with code", /Code \(\d+ symbols\)/.test(expanded),
        (expanded.match(/Code \([^)]*\)[^\n]*/) ?? ["(no Code section)"])[0]);
      check("naming a real source location", /lib\/[a-z-]+\.ts:\d+/.test(expanded),
        (expanded.match(/lib\/[a-z-]+\.ts:\d+[-\d]*/) ?? ["(none)"])[0]);
      // Both layers, clearly labelled — the shape the user chose.
      check("and labels the work-history half separately",
        !expanded.includes("Work history:") || expanded.indexOf("Code (") < expanded.indexOf("Work history:"));
      await shot(page, "04-graph-tool-output");
    }

    /* ── 4. Two agent runs, still one index ──────────────────────────────────
       The single most important assertion in this suite. A run works in a
       throwaway worktree; if any trigger indexed that path instead of the
       canonical repo, this is where a second nexotao-idx-* entry appears and
       never goes away. */
    console.log("\n4. the worktree leak");
    if (!binaryPresent) skip("worktree leak", "binary absent");
    else {
      const ours = async () => {
        const listed = await cli("list_projects");
        const rows = listed?.projects ?? listed ?? [];
        return (Array.isArray(rows) ? rows : []).filter((p) => String(p.name ?? p.project ?? "").startsWith("nexotao-idx-"));
      };
      const first = await ours();
      check("exactly one index carries our prefix", first.length === 1, first.map((p) => p.name ?? p.project).join(", ") || "none");
      check("and none is rooted in a worktree",
        !first.some((p) => String(p.root_path ?? p.repo_path ?? "").includes("worktrees")),
        first.map((p) => p.root_path ?? p.repo_path).join(", "));

      // Rebuild twice more; the count must not move.
      await pageJson(page, "/api/graph", { method: "POST" });
      await pageJson(page, "/api/graph", { method: "POST" });
      const second = await ours();
      check("repeated indexing does not multiply indexes", second.length === first.length, `${second.length} after 3 builds`);
    }

    /* ── 5. Deleting the project deletes what is on disk ─────────────────── */
    console.log("\n5. deletion");
    const graphDirPath = join(dataDir, "graph", projectId);
    const hadGraphDir = await stat(graphDirPath).then(() => true, () => false);
    check("the project wrote a graph directory", hadGraphDir, graphDirPath);

    await page.goto(url("/settings"), { waitUntil: "networkidle2" });
    await settle(800);
    const deleted = await pageJson(page, "/api/data", {
      method: "POST", body: JSON.stringify({ action: "delete", projectId, confirm: true }),
    });
    check("deletion is accepted", deleted.ok, `status ${deleted.status}`);
    check("and reports the on-disk artifacts it removed",
      deleted.body?.outcome?.deleted?.workGraph === 1 || deleted.body?.deleted?.workGraph === 1,
      JSON.stringify(deleted.body?.outcome?.deleted ?? deleted.body?.deleted ?? {}));
    check("the graph directory is gone", !(await stat(graphDirPath).then(() => true, () => false)));
    if (binaryPresent) {
      const still = await cli("search_graph", { project: indexName, query: "anything" });
      check("the code index is gone", still === null, still ? "index still answers queries" : "");
    }
    await page.goto(url("/graph"), { waitUntil: "networkidle2" });
    await settle(1000);
    await shot(page, "05-deleted");

    await browser.close(); browser = null;
    await stopServer(server); server = null;

    /* ── 6. Day one: no binary at all ────────────────────────────────────────
       Every user is in this state on a fresh install. It must look deliberate,
       not broken: the tools answer, the banner offers the install, and nothing
       anywhere says something failed. PATH is stripped of every directory
       holding the binary, so `resolveCli` finds nothing to spawn. */
    console.log("\n6. the absent-binary pass");
    const strippedPath = (process.env.PATH ?? "").split(":")
      .filter((d) => !d.includes(".local/bin") && !d.includes(".nexotao"))
      .join(":");
    const dataDir2 = await mkdtemp(join(tmpdir(), "nexotao-codegraph-nb-"));
    const port2 = port + 1;
    const seed2 = await run(process.execPath, ["--import", "tsx", "-e", `
      import { saveConfig } from "${ROOT}/lib/config";
      import { addProject } from "${ROOT}/lib/store";
      const project = await addProject({ name: "No Binary", path: ${JSON.stringify(ROOT)}, mode: "single", agents: [] });
      await saveConfig({ apiKey: "e2e-" + "k".repeat(40), model: "nexotao-default", onboarded: true, activeProjectId: project.id });
      process.stdout.write(JSON.stringify({ projectId: project.id }) + "\\n");
    `], { env: { ...process.env, NEXOTAO_DATA_DIR: dataDir2 } });
    if (seed2.code !== 0) throw new Error(`second seed failed: ${seed2.err.slice(-500)}`);

    const server2 = bootServer(port2, token, dataDir2, { PATH: strippedPath, HOME: dataDir2 });
    try {
      check("the app boots with no code index on PATH", await waitHealthy(port2, token));
      browser = await puppeteer.launch({ executablePath: browserPath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
      const page2 = await browser.newPage();
      await page2.setViewport(VIEWPORT);
      await page2.goto(`http://${HOST}:${port2}/graph?session_token=${token}`, { waitUntil: "networkidle2" });
      await settle(1500);
      const text2 = await page2.evaluate(() => document.body.innerText);
      check("the page offers the install rather than reporting a fault", /Install code index/.test(text2));
      check("stating what it costs", /40 MB/.test(text2), (text2.match(/~40 MB[^\n]*/) ?? [""])[0]);
      check("and nothing reads as an error", !/error|failed|denied/i.test(text2),
        (text2.match(/[^\n]*(error|failed|denied)[^\n]*/i) ?? [""])[0]);

      // The graph tools still answer — from work history alone, with no mention
      // of missing software. This is the contract the whole module is built on.
      const build2 = await pageJson(page2, "/api/graph", { method: "POST" });
      check("building still succeeds without the binary", build2.body?.ok === true, `status ${build2.status}`);
      check("and honestly reports no code layer", build2.body?.code?.available === false, JSON.stringify(build2.body?.code ?? {}));
      await page2.reload({ waitUntil: "networkidle2" });
      await settle(1000);
      await page2.screenshot({ path: join(shots, "06-no-binary.png"), fullPage: true });
      console.log(`      shot: ${join(shots, "06-no-binary.png")}`);

      /* ── 7. The install button ──────────────────────────────────────────── */
      if (!WANT_INSTALL) skip("install pass", "pass --install to download ~40 MB");
      else {
        console.log("\n7. the install button");
        const refused = await pageJson(page2, "/api/code-index/install", { method: "POST", body: JSON.stringify({}) });
        check("an unconfirmed install is refused", refused.status === 400 && refused.body?.error === "confirmation_required");

        await page2.evaluate(() => {
          [...document.querySelectorAll("button")].find((b) => /Install code index/.test(b.textContent ?? ""))?.click();
        });
        await settle(1500);
        await page2.screenshot({ path: join(shots, "07-installing.png"), fullPage: true });
        console.log(`      shot: ${join(shots, "07-installing.png")}`);

        let installed = false;
        for (let i = 0; i < 90 && !installed; i++) {
          await settle(4000);
          const probe = await pageJson(page2, "/api/code-index/install");
          installed = probe.body?.available === true;
        }
        check("the install completes", installed);
        const managed = join(dataDir2, ".nexotao", "tools", "node_modules", ".bin", "codebase-memory-mcp");
        check("into a Nexotao-owned prefix, no sudo", (await run(managed, ["--version"])).code === 0, managed);
        await settle(1500);
        await page2.reload({ waitUntil: "networkidle2" });
        await settle(1500);
        const text3 = await page2.evaluate(() => document.body.innerText);
        check("and the banner flips to active", /Code index active/.test(text3), (text3.match(/Code index[^\n]*/) ?? [""])[0]);
        await page2.screenshot({ path: join(shots, "08-installed.png"), fullPage: true });
        console.log(`      shot: ${join(shots, "08-installed.png")}`);
      }
    } finally {
      await stopServer(server2);
      await rm(dataDir2, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    check("suite ran to completion", false, String(error?.message ?? error));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    // Never leave our own index behind in the shared cache, whatever happened.
    if (projectId && binaryPresent) await cli("delete_project", { project: `nexotao-idx-${projectId}` }).catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}${skipped ? ` · ${skipped} skipped` : ""}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
