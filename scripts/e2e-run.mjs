// End-to-end browser suite for the public-beta critical flows. Boots the real
// built server against a throwaway data dir, drives a real Chromium via
// puppeteer-core, and asserts canonical server state for each flow:
//   delegation, dependencies, approval, cancel, retry, review/done, restart.
//
// Requires a built app (`npm run build`) and a Chromium resolvable by
// scripts/e2e/browser.mjs (install: npx @puppeteer/browsers install chrome-headless-shell@stable).
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./e2e/browser.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const HOST = "127.0.0.1";
const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
}
function check(name, cond, detail) { record(name, Boolean(cond), detail); return Boolean(cond); }

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`${bin} ${args.join(" ")} exited ${code}\n${err}`)));
  });
}

async function waitHealthy(port, token) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://${HOST}:${port}/api/health`, { headers: { cookie: `nexotao_session=${token}` } });
      if (r.ok && (await r.json()).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function bootServer(port, token, dataDir) {
  const nextBin = require.resolve("next/dist/bin/next");
  return spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", HOST], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOSTNAME: HOST, NEXOTAO_ALLOWED_HOST: `${HOST}:${port}`, NEXOTAO_SESSION_TOKEN: token, NEXOTAO_DATA_DIR: dataDir, NEXOTAO_NO_OPEN: "1" },
  });
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise((resolve) => { const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000); proc.once("exit", () => { clearTimeout(t); resolve(); }); });
}

// A same-origin fetch executed inside the authenticated browser page.
async function pageJson(page, path, init) {
  return page.evaluate(async (p, i) => {
    const r = await fetch(p, i ? { ...i, headers: { "Content-Type": "application/json", ...(i.headers || {}) } } : undefined);
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  }, path, init ?? null);
}

async function poll(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

async function main() {
  const executablePath = resolveBrowser();
  if (!executablePath) {
    console.error("No Chromium found. Install one: npx @puppeteer/browsers install chrome-headless-shell@stable");
    process.exit(2);
  }
  const port = 4500 + Math.floor((process.pid % 400));
  const token = "e2e-" + "t".repeat(40);
  const dataDir = await mkdtemp(join(tmpdir(), "nexotao-e2e-"));
  const projectPath = await mkdtemp(join(tmpdir(), "nexotao-e2e-project-"));
  const artifacts = join(ROOT, "e2e-artifacts");
  await mkdir(artifacts, { recursive: true });

  let server, browser;
  try {
    // 1. Seed the fixture into the data dir.
    const seedOut = await run(process.execPath, ["--import", "tsx", join(ROOT, "scripts/e2e/seed.ts")], {
      env: { ...process.env, NEXOTAO_DATA_DIR: dataDir, NEXOTAO_PROJECT_PATH: projectPath },
    });
    const ids = JSON.parse(seedOut.trim().split("\n").pop());

    // 2. Boot the real server and a real browser.
    server = bootServer(port, token, dataDir);
    check("server boots and reports healthy", await waitHealthy(port, token));
    browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Auth bootstrap: the session_token query sets the httpOnly session cookie.
    await page.goto(`http://${HOST}:${port}/board?session_token=${token}`, { waitUntil: "networkidle2" });
    check("authenticated board renders", (await page.content()).length > 500);
    await page.screenshot({ path: join(artifacts, "01-board.png") });

    // 3. Delegation — add a child issue from the issue detail UI.
    await page.goto(`http://${HOST}:${port}/board/${ids.root}?session_token=${token}`, { waitUntil: "networkidle2" });
    await page.waitForSelector('input[aria-label="New child issue title"]');
    await page.type('input[aria-label="New child issue title"]', "Packaged install smoke");
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add");
      btn?.click();
    });
    const delegated = await poll(async () => {
      const r = await pageJson(page, `/api/issues/${ids.root}`);
      return r.body?.children?.some((c) => c.title === "Packaged install smoke");
    });
    check("delegation creates a child issue", delegated);
    await page.screenshot({ path: join(artifacts, "02-delegation.png") });

    // 4. Dependencies — add a blocker via the blocker select.
    await page.select('select[aria-label="Add a blocker"]', ids.blocker);
    const dependency = await poll(async () => {
      const r = await pageJson(page, `/api/issues/${ids.root}`);
      return r.body?.blockedBy?.some((b) => b.id === ids.blocker);
    });
    check("dependency edge is recorded", dependency);
    await page.screenshot({ path: join(artifacts, "03-dependency.png") });

    // 5. Approval — approve the pending plan card.
    await page.reload({ waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Approve");
      btn?.click();
    });
    const approved = await poll(async () => {
      const r = await pageJson(page, `/api/issues/${ids.root}`);
      return r.body?.approvals?.some((a) => a.id === ids.approvalId && a.status === "approved");
    });
    check("approval decision is persisted", approved);

    // 6. Review -> done transition via the Status select.
    await page.goto(`http://${HOST}:${port}/board/${ids.review}?session_token=${token}`, { waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const select = [...document.querySelectorAll("select")].find((s) => s.value === "in_review");
      if (select) { select.value = "done"; select.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    const done = await poll(async () => (await pageJson(page, `/api/issues/${ids.review}`)).body?.issue?.status === "done");
    check("review issue transitions to done", done);
    await page.screenshot({ path: join(artifacts, "04-review-done.png") });

    // 7. Cancel — cancel a non-terminal run through the real endpoint.
    const cancelResp = await pageJson(page, "/api/run/cancel", { method: "POST", body: JSON.stringify({ runId: ids.cancelRunId }) });
    check("cancel endpoint reports cancelled", cancelResp.body?.cancelled === true, `status ${cancelResp.status}`);
    const cancelledState = await poll(async () => {
      const r = await pageJson(page, `/api/issues/${ids.root}`);
      return r.body?.runs?.some((run) => run.id === ids.cancelRunId && run.status === "cancelled");
    });
    check("cancelled run is terminal in the ledger", cancelledState);

    // 8. Retry / re-invoke — moving an assigned issue to todo enqueues a fresh run.
    const retryResp = await pageJson(page, "/api/issues", { method: "PATCH", body: JSON.stringify({ id: ids.retry, status: "todo" }) });
    check("re-invoke request accepted", retryResp.ok, `status ${retryResp.status}`);
    const requeued = await poll(async () => ((await pageJson(page, `/api/issues/${ids.retry}`)).body?.runs?.length ?? 0) >= 1);
    check("retry enqueues a new run", requeued);

    // 9. Restart recovery — reboot the server, state must survive.
    await stopServer(server);
    server = bootServer(port, token, dataDir);
    check("server reboots healthy", await waitHealthy(port, token));
    await page.goto(`http://${HOST}:${port}/board/${ids.review}?session_token=${token}`, { waitUntil: "networkidle2" });
    const survivedReview = (await pageJson(page, `/api/issues/${ids.review}`)).body?.issue?.status === "done";
    const survivedChild = (await pageJson(page, `/api/issues/${ids.root}`)).body?.children?.some((c) => c.title === "Packaged install smoke");
    check("done status survives restart", survivedReview);
    check("delegated child survives restart", survivedChild);
    await page.screenshot({ path: join(artifacts, "05-restart-recovered.png") });

    await writeFile(join(artifacts, "e2e-results.json"), JSON.stringify({ ranAt: Date.now(), executablePath, results }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(projectPath, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
