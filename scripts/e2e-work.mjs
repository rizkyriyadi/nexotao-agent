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

/** Attach the tab to the console, so a crash or an uncaught error in the app is
 *  reported as itself rather than surfacing later as a detached frame. */
function watch(page) {
  page.on("pageerror", (error) => console.log(`  [page error] ${error.message}`));
  page.on("error", (error) => console.log(`  [tab crashed] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`  [console] ${message.text().slice(0, 300)}`);
  });
  return page;
}

/* The two ways the driver loses its grip on a healthy app, and what each means.

   A `goto` to a route the Next router has already prefetched detaches the frame
   puppeteer is holding: the tab keeps working, the driver's handle to it does
   not. Every /work destination is in the sub-nav, so the first move is to click
   through it the way a user would — that never detaches, and it exercises the
   client-side navigation besides.

   `chrome-headless-shell` also segfaults occasionally, deep in its own Cocoa run
   loop (`objc_autoreleasePoolPop`, no app frame on the stack). That is a browser
   bug, so losing the remaining checks to it would report a driver crash as an
   app failure. Both recoveries end the same way: get a live tab on the target
   URL, relaunching the browser if that is what it takes. */
const VIEWPORT = { width: 1440, height: 940 };
let browser = null;
let browserPath = null;

async function launchBrowser() {
  browser = await puppeteer.launch({ executablePath: browserPath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  return browser;
}

/** A fresh tab, relaunching the browser first if the old one died. Cookies live
 *  on the browser, so a relaunch loses the session — the token is replayed. */
async function freshPage(target, token) {
  if (!browser?.connected) await launchBrowser();
  const page = watch(await browser.newPage());
  await page.setViewport(VIEWPORT);
  const url = new URL(target);
  if (!url.searchParams.has("session_token")) url.searchParams.set("session_token", token);
  await page.goto(url.toString(), { waitUntil: "networkidle2" });
  return page;
}

async function visit(page, target, token) {
  const { pathname, search } = new URL(target);
  // A query string carries something the click cannot — the session token on the
  // first load — so only a bare path is eligible for the in-app route.
  if (!search && browser?.connected) {
    try { if (await follow(page, pathname)) return page; } catch { /* fall through to a reload */ }
  }
  try {
    await page.goto(target, { waitUntil: "networkidle2" });
    return page;
  } catch (error) {
    if (!/detached|disposed|Target closed|Connection closed|Session closed/i.test(String(error))) throw error;
    const dead = !browser?.connected;
    if (dead) console.log("  [browser died — relaunching; this is a chrome-headless-shell crash, not the app]");
    const fresh = await freshPage(target, token);
    if (!dead) await page.close().catch(() => {});
    return fresh;
  }
}

/* Follow an in-app link the way a user would, rather than issuing a fresh
   `goto`. A `goto` to a route the router has already prefetched detaches the
   frame puppeteer is holding — the page itself is fine, the driver's handle is
   not — and clicking exercises the client-side navigation besides. */
async function follow(page, href) {
  // Bail before arming the navigation wait when nothing links there, rather than
  // sitting out its full timeout for a link that was never going to be clicked.
  const linked = await page.evaluate(
    (target) => [...document.querySelectorAll("a")].some((anchor) => anchor.getAttribute("href") === target),
    href,
  ).catch(() => false);
  if (!linked) return false;

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
    page.evaluate((target) => {
      [...document.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === target)?.click();
    }, href),
  ]);
  await settle(900);
  return page.url().endsWith(href);
}

async function main() {
  browserPath = resolveBrowser();
  if (!browserPath) { console.error("No Chromium found."); process.exit(2); }

  const port = 4700 + (process.pid % 200);
  const token = "work-" + "t".repeat(40);
  const dataDir = await mkdtemp(join(tmpdir(), "nexotao-work-"));
  const projectPath = await mkdtemp(join(tmpdir(), "nexotao-work-project-"));
  const shots = join(ROOT, "e2e-artifacts");
  await mkdir(shots, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: join(shots, `work-${name}.png`) });

  // `browser` is module-level so `visit`/`freshPage` can replace it after a crash.
  let server;
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

    await launchBrowser();
    let page = watch(await browser.newPage());
    await page.setViewport(VIEWPORT);
    const url = (path) => `http://${HOST}:${port}${path}`;

    // 1. The board renders the seeded work in its columns.
    page = await visit(page, url(`/work?session_token=${token}`), token);
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
      page = await visit(page, url(peek.href), token);
      await settle(900);
      const landed = await page.evaluate(() => document.body.innerText);
      check("conversation link lands on the issue", landed.includes("Verify the smoke matrix"));
      await shot(page, "09-conversation");
    }

    // 6. Cycles: the list, then the one the fixture seeded work into.
    page = await visit(page, url("/work/cycles"), token);
    await settle(1100);
    const cyclesText = await page.evaluate(() => document.body.innerText);
    check("cycles list draws the seeded cycle", cyclesText.includes("Sprint 1"), cyclesText.slice(0, 120).replace(/\n/g, " "));
    await shot(page, "10-cycles");

    page = await visit(page, url(`/work/cycles/${ids.cycleId}`), token);
    await settle(1100);
    const cycleDetail = await page.evaluate(() => ({
      text: document.body.innerText,
      svgs: document.querySelectorAll("svg[role='img']").length,
    }));
    check("cycle detail names the cycle", cycleDetail.text.includes("Sprint 1"));
    // The fixture has one day of snapshots, so the burn-down explains itself
    // rather than drawing — either the card or the chart is a pass, an
    // "Application error" is not.
    check("cycle detail shows the burn-down card", /Burn-down/i.test(cycleDetail.text), `${cycleDetail.svgs} svg charts`);
    await shot(page, "11-cycle-detail");

    // 7. Modules.
    page = await visit(page, url("/work/modules"), token);
    await settle(1100);
    check("modules list draws the seeded module", (await page.evaluate(() => document.body.innerText)).includes("Platform"));
    await shot(page, "12-modules");

    page = await visit(page, url(`/work/modules/${ids.moduleId}`), token);
    await settle(1100);
    const moduleDetail = await page.evaluate(() => document.body.innerText);
    check("module detail lists its work", moduleDetail.includes("Platform") && /Work in this module/i.test(moduleDetail));
    await shot(page, "13-module-detail");

    // 8. Pages: create one, write markdown, save, and read it back rendered.
    page = await visit(page, url("/work/pages"), token);
    await settle(900);
    await page.type('input[aria-label="Page title"]', "Release notes");
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New page")?.click());
    await settle(1300);
    const pageRow = await page.evaluate(() => [...document.querySelectorAll("a")].find((a) => a.textContent.includes("Release notes"))?.getAttribute("href") ?? null);
    check("a page can be created", Boolean(pageRow), String(pageRow));
    await shot(page, "14-pages");

    if (pageRow) {
      check("the page opens from the list", await follow(page, pageRow), page.url());
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Edit")?.click());
      await settle(500);
      await page.type('textarea[aria-label="Page body"]', "## Shipped\n\n- Work surface\n- Cycles and modules\n");
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save")?.click());
      await settle(1500);
      const rendered = await page.evaluate(() => ({
        heading: Boolean([...document.querySelectorAll("h2, h3")].find((h) => h.textContent.trim() === "Shipped")),
        items: document.querySelectorAll("article li").length,
      }));
      check("page body saves and renders as markdown", rendered.heading && rendered.items >= 2, JSON.stringify(rendered));
      await shot(page, "15-page-detail");
    }

    // 9. Intake: empty by default, then populated once something is marked pending.
    page = await visit(page, url("/work/intake"), token);
    await settle(1000);
    check("intake is empty by default", /Nothing waiting/i.test(await page.evaluate(() => document.body.innerText)));
    await shot(page, "16-intake-empty");

    const marked = await page.evaluate(async (id) => {
      const r = await fetch("/api/work/issues", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, intakeStatus: "pending" }),
      });
      return { ok: r.ok, status: r.status };
    }, ids.review);
    check("an item can be put into intake", marked.ok, JSON.stringify(marked));
    await page.reload({ waitUntil: "networkidle2" });
    await settle(1100);
    check("intake queue shows the pending item", (await page.evaluate(() => document.body.innerText)).includes("Verify the smoke matrix"));
    await shot(page, "17-intake-queue");

    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept")?.click());
    await settle(1500);
    const triaged = await pageJson(page, "/api/work/intake");
    check("accepting clears the queue", (triaged.body?.pending ?? []).length === 0, `${triaged.body?.pending?.length} pending`);
    check("accepted item is recorded as triaged", (triaged.body?.recent ?? []).some((i) => i.id === ids.review && i.intakeStatus === "accepted"));
    await shot(page, "18-intake-triaged");

    // 10. Analytics.
    page = await visit(page, url("/work/analytics"), token);
    await settle(1400);
    const analytics = await page.evaluate(() => ({
      text: document.body.innerText,
      charts: document.querySelectorAll("svg[role='img']").length,
    }));
    check("analytics draws its stat cards", /Average cycle time/i.test(analytics.text) && /Throughput/i.test(analytics.text));
    check("analytics draws charts", analytics.charts >= 1, `${analytics.charts} svg charts`);
    check("analytics lists the cycle burn-down", analytics.text.includes("Sprint 1"));
    await shot(page, "19-analytics");
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
