// Automated accessibility audit — the enforced beta gate (see docs/accessibility.md).
// Boots the real built server against a throwaway data dir, drives real Chromium,
// and checks the critical pages against a documented threshold:
//   1. Every interactive control (button, link, input, select, textarea) has an
//      accessible name.
//   2. The document sets <html lang>.
//   3. No horizontal overflow on the critical path at a 390x844 mobile viewport.
// Exits non-zero on any violation so CI blocks the release.
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

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}\n${err}`)));
  });
}

async function waitHealthy(port, token) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://${HOST}:${port}/api/health`, { headers: { cookie: `nexotao_session=${token}` } }); if (r.ok && (await r.json()).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// The DOM-side probe. Returns violations for one page.
function AUDIT() {
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) { const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim(); if (t) return t; }
    if (el.id) { const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (lab && lab.textContent.trim()) return lab.textContent.trim(); }
    const wrapping = el.closest("label");
    if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
    if (el.getAttribute("title")?.trim()) return el.getAttribute("title").trim();
    const text = (el.textContent || "").trim();
    if (text) return text;
    if (el.tagName === "SELECT" && el.options[el.selectedIndex]?.textContent.trim()) return "";
    return "";
  };
  const violations = [];
  const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea')];
  for (const el of controls) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (!accessibleName(el)) violations.push({ rule: "accessible-name", tag: el.tagName.toLowerCase(), snippet: el.outerHTML.slice(0, 120) });
  }
  if (!document.documentElement.getAttribute("lang")) violations.push({ rule: "document-lang", tag: "html", snippet: "<html> missing lang" });
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (overflow > 4) violations.push({ rule: "horizontal-overflow", tag: "html", snippet: `scrollWidth exceeds viewport by ${overflow}px` });
  return violations;
}

async function main() {
  const executablePath = resolveBrowser();
  if (!executablePath) { console.error("No Chromium found. Install: npx @puppeteer/browsers install chrome-headless-shell@stable"); process.exit(2); }
  const port = 4700 + Math.floor((process.pid % 200));
  const token = "a11y-" + "t".repeat(40);
  const dataDir = await mkdtemp(join(tmpdir(), "nexotao-a11y-"));
  const projectPath = await mkdtemp(join(tmpdir(), "nexotao-a11y-project-"));
  const artifacts = join(ROOT, "e2e-artifacts");
  await mkdir(artifacts, { recursive: true });

  const seedOut = await run(process.execPath, ["--import", "tsx", join(ROOT, "scripts/e2e/seed.ts")], { env: { ...process.env, NEXOTAO_DATA_DIR: dataDir, NEXOTAO_PROJECT_PATH: projectPath } });
  const ids = JSON.parse(seedOut.trim().split("\n").pop());

  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", HOST], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOSTNAME: HOST, NEXOTAO_ALLOWED_HOST: `${HOST}:${port}`, NEXOTAO_SESSION_TOKEN: token, NEXOTAO_DATA_DIR: dataDir, NEXOTAO_NO_OPEN: "1" },
  });

  let browser, totalViolations = 0;
  const report = [];
  try {
    if (!await waitHealthy(port, token)) throw new Error("server did not become healthy");
    browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    const pages = [
      { name: "board", url: `/board?session_token=${token}` },
      { name: "issue-detail", url: `/board/${ids.root}?session_token=${token}` },
      { name: "settings", url: `/settings?session_token=${token}` },
    ];
    // Critical path is audited at the documented 390x844 mobile viewport.
    for (const target of pages) {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`http://${HOST}:${port}${target.url}`, { waitUntil: "networkidle2" });
      await new Promise((r) => setTimeout(r, 400));
      const violations = await page.evaluate(AUDIT);
      report.push({ page: target.name, violations });
      totalViolations += violations.length;
      console.log(`${violations.length ? "FAIL" : "PASS"}  ${target.name}: ${violations.length} violation(s)`);
      for (const v of violations) console.log(`   - [${v.rule}] <${v.tag}> ${v.snippet}`);
      await page.close();
    }
    await writeFile(join(artifacts, "a11y-results.json"), JSON.stringify({ ranAt: Date.now(), threshold: "beta", report }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
    await new Promise((resolve) => { const t = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 4000); server.once("exit", () => { clearTimeout(t); resolve(); }); });
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(projectPath, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nAccessibility audit: ${totalViolations} violation(s) across ${report.length} pages`);
  process.exit(totalViolations ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
