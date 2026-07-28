// Browser verification for the /work surface: boots the built server against a
// throwaway data dir, drives a real Chromium, and screenshots each layout plus
// the two drags that matter — the one the lifecycle refuses and the one it
// allows. Screenshots land in e2e-artifacts/work-*.png.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./e2e/browser.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const HOST = "127.0.0.1";
let failures = 0;

function check(name, cond, detail) {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
  return ok;
}

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`exited ${code}\n${err}`)));
  });
}

async function waitHealthy(port, token) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`http://${HOST}:${port}/api/health`, { headers: { cookie: `nexotao_session=${token}` } });
      if (r.ok && (await r.json()).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function pageJson(page, path) {
  return page.evaluate(async (p) => {
    const r = await fetch(p);
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  }, path);
}

/* HTML5 drag-and-drop cannot be produced by CDP mouse input, so the drag is
   dispatched as real DOM events sharing one DataTransfer. React listens at the
   root, so bubbling synthetic events reach the same handlers a mouse would.
   The events are dispatched in separate turns, not one tick: `dragstart` sets
   React state that `drop` reads, and a real drag is frames apart, so firing all
   three synchronously would have `drop` read the state from before the drag. */
async function drag(page, cardText, columnLabel) {
  const found = await page.evaluate((text, column) => {
    const card = [...document.querySelectorAll('[draggable="true"]')].find((el) => el.textContent.includes(text));
    const heading = [...document.querySelectorAll("section h2")].find((h) => h.textContent.trim().toLowerCase() === column.toLowerCase());
    if (!card || !heading) return { ok: false, card: Boolean(card), column: Boolean(heading) };
    window.__drag = { card, target: heading.closest("section"), transfer: new DataTransfer() };
    return { ok: true };
  }, cardText, columnLabel);
  if (!found.ok) return found;

  const fire = (which, type) => page.evaluate((w, t) => {
    const { transfer } = window.__drag;
    window.__drag[w].dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, which, type);

  for (const [which, type] of [["card", "dragstart"], ["target", "dragover"], ["target", "drop"], ["card", "dragend"]]) {
    await fire(which, type);
    await settle(150);
  }
  return { ok: true };
}

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const executablePath = resolveBrowser();
  if (!executablePath) { console.error("No Chromium found."); process.exit(2); }

  const port = 4700 + (process.pid % 200);
  const token = "work-" + "t".repeat(40);
  const dataDir = await mkdtemp(join(tmpdir(), "nexotao-work-"));
  const projectPath = await mkdtemp(join(tmpdir(), "nexotao-work-project-"));
  const shots = join(ROOT, "e2e-artifacts");
  await mkdir(shots, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: join(shots, `work-${name}.png`) });

  let server, browser;
  try {
    const seedOut = await run(process.execPath, ["--import", "tsx", join(ROOT, "scripts/e2e/seed-work.ts")], {
      env: { ...process.env, NEXOTAO_DATA_DIR: dataDir, NEXOTAO_PROJECT_PATH: projectPath },
    });
    const ids = JSON.parse(seedOut.trim().split("\n").pop());

    const nextBin = require.resolve("next/dist/bin/next");
    server = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", HOST], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), HOSTNAME: HOST, NEXOTAO_ALLOWED_HOST: `${HOST}:${port}`, NEXOTAO_SESSION_TOKEN: token, NEXOTAO_DATA_DIR: dataDir, NEXOTAO_NO_OPEN: "1" },
    });
    if (!check("server boots", await waitHealthy(port, token))) throw new Error("server never became healthy");

    browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 940 });
    const url = (path) => `http://${HOST}:${port}${path}`;

    // 1. The board renders the seeded work in its columns.
    await page.goto(url(`/work?session_token=${token}`), { waitUntil: "networkidle2" });
    await page.waitForSelector("section h2", { timeout: 15000 });
    await settle();
    const columns = await page.$$eval("section h2", (els) => els.map((el) => el.textContent.trim()));
    check("board draws the workflow columns", columns.length >= 5, columns.join(" | "));
    const cards = await page.$$eval('[draggable="true"]', (els) => els.length);
    check("board draws the seeded cards", cards >= 4, `${cards} cards`);
    await shot(page, "01-board");

    // 2. The refused drag: Todo -> In Progress is checkout-only.
    const refusal = await drag(page, "Rewrite the executor", "In Progress");
    check("refused drag dispatched", refusal.ok, JSON.stringify(refusal));
    await settle(1400);
    const toast = await page.evaluate(() => document.body.innerText.match(/.*checkout.*|.*agent picks it up.*/i)?.[0] ?? "");
    check("In Progress drop is refused with a reason", /checkout|agent picks it up/i.test(toast), toast);
    await shot(page, "02-refused-in-progress");
    const stillTodo = await pageJson(page, "/api/work/issues");
    const refused = stillTodo.body?.issues?.find((i) => i.id === ids.refuse);
    check("refused card kept its status", refused?.status === "todo", `status=${refused?.status}`);

    // 3. The allowed drag: Backlog -> Todo.
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('[draggable="true"]');
    await settle();
    const allowed = await drag(page, "Wire the settings page", "Todo");
    check("allowed drag dispatched", allowed.ok, JSON.stringify(allowed));
    await settle(1400);
    const after = await pageJson(page, "/api/work/issues");
    const moved = after.body?.issues?.find((i) => i.id === ids.drag);
    check("Backlog -> Todo is accepted", moved?.status === "todo", `status=${moved?.status}`);
    await shot(page, "03-moved-to-todo");

    // 4. Every layout draws.
    for (const [label, name] of [["List", "04-list"], ["Spreadsheet", "05-spreadsheet"], ["Calendar", "06-calendar"], ["Timeline", "07-timeline"]]) {
      const clicked = await page.evaluate((text) => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text || b.getAttribute("aria-label") === text || b.title === text);
        if (!btn) return false;
        btn.click();
        return true;
      }, label);
      await settle(1000);
      const body = await page.evaluate(() => document.body.innerText);
      check(`${label} layout renders`, clicked && body.length > 200 && !/Application error/i.test(body));
      await shot(page, name);
    }

    // 5. A card opens the properties panel, which links to the conversation.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Board");
      btn?.click();
    });
    await settle(900);
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('[draggable="true"]')].find((el) => el.textContent.includes("Verify the smoke matrix"));
      card?.querySelector("button")?.click() ?? card?.click();
    });
    await settle(1200);
    const peek = await page.evaluate(() => {
      const link = [...document.querySelectorAll("a")].find((a) => a.textContent.includes("Open conversation"));
      return { text: document.body.innerText.includes("Verify the smoke matrix"), href: link?.getAttribute("href") ?? null };
    });
    check("properties panel opens", peek.text);
    check("panel links to the conversation", peek.href?.startsWith("/board/"), String(peek.href));
    await shot(page, "08-issue-peek");

    if (peek.href) {
      await page.goto(url(peek.href), { waitUntil: "networkidle2" });
      await settle(900);
      const landed = await page.evaluate(() => document.body.innerText);
      check("conversation link lands on the issue", landed.includes("Verify the smoke matrix"));
      await shot(page, "09-conversation");
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => { const t = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 4000); server.once("exit", () => { clearTimeout(t); resolve(); }); });
    }
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
