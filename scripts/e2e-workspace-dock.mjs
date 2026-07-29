// Drives the docked workspace the way the user described it: the tree beside the
// prompt, a file opened into a reader, an edit saved back to disk, and `@`
// naming a real file in the composer.
//
// Usage: NEXOTAO_TARGET=127.0.0.1:4322 node scripts/e2e-workspace-dock.mjs
import { mkdirSync, readFileSync as read, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./e2e/browser.mjs";
import { checker } from "./e2e/drive.mjs";

// Driven straight at the loopback origin rather than through the host-mapping
// trick: Chrome upgrades a mapped hostname to https and the static chunks then
// fail to load, which looks like an app crash and is only the harness.
const TARGET = process.env.NEXOTAO_TARGET ?? "127.0.0.1:4322";
// The workspace this asserts against is whatever project the app has open. Both
// the folder name and the file the save test writes through come from the
// environment, so this runs against any checkout rather than only mine.
const FIXTURE = process.env.NEXOTAO_FIXTURE_ROOT ?? "";
const FIXTURE_NAME = FIXTURE ? FIXTURE.split("/").filter(Boolean).pop() : "";
const FIXTURE_FILE = process.env.NEXOTAO_FIXTURE_FILE ?? "README.md";
// A word the fixture file really contains, and a path fragment the tree really
// holds — the two things "did it render the contents" and "did the picker find a
// real file" have to assert against something for.
const FIXTURE_WORD = process.env.NEXOTAO_FIXTURE_WORD ?? "";
const FIXTURE_MENTION = process.env.NEXOTAO_FIXTURE_MENTION ?? "";
if (!FIXTURE || !FIXTURE_WORD || !FIXTURE_MENTION) {
  console.error("usage: NEXOTAO_FIXTURE_ROOT=<project folder the app has open> \\");
  console.error("       NEXOTAO_FIXTURE_WORD=<a word inside its README> \\");
  console.error("       NEXOTAO_FIXTURE_MENTION=<src/some-file.js> node scripts/e2e-workspace-dock.mjs");
  process.exit(2);
}
const mentionQuery = FIXTURE_MENTION.split("/").pop().slice(0, 4);
const ORIGIN = `http://${TARGET}`;
const token = read(join(process.cwd(), ".env.runtime"), "utf8")
  .split("\n").find((l) => l.startsWith("NEXOTAO_SESSION_TOKEN="))
  .slice("NEXOTAO_SESSION_TOKEN=".length).trim();

const dir = join(process.cwd(), "e2e-artifacts", "workspace-dock");
mkdirSync(dir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: resolveBrowser(),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
const goto = (path) => page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2", timeout: 60_000 });
const shot = async (name) => { const f = join(dir, `${name}.png`); await page.screenshot({ path: f, fullPage: true }); console.log(`   shot: ${f}`); };
const text = () => page.evaluate(() => document.body.innerText);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await goto(`/board?session_token=${token}`);
const { check, state } = checker();

try {
  // ---- the dock, on the control panel -------------------------------------
  await goto("/board");
  await wait(1500);
  let body = await text();
  check(/Workspace/i.test(body), "the workspace panel is docked beside the prompt");
  check(body.includes(FIXTURE_NAME), "it names the open project root", FIXTURE_NAME);
  check(body.includes(FIXTURE_FILE), "and lists the project's real files");
  await shot("01-board-dock");

  // The retired page must actually be gone, not merely unlinked.
  const gone = await page.evaluate(async (origin) => {
    const r = await fetch(`${origin}/files`, { redirect: "manual" });
    return r.status;
  }, ORIGIN);
  check(gone === 404, "the standalone /files page is retired", `status ${gone}`);

  // ---- opening a file ------------------------------------------------------
  const opened = await page.evaluate((name) => {
    const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
    if (!row) return false;
    row.click();
    return true;
  }, FIXTURE_FILE);
  check(opened, "a file row is clickable");
  await wait(1200);
  body = await text();
  check(body.toLowerCase().includes(FIXTURE_WORD.toLowerCase()), "the reader renders the file's contents, not its name");
  await shot("02-preview");

  // ---- editing and saving --------------------------------------------------
  const marker = `<!-- e2e ${Date.now()} -->`;
  const editing = await page.evaluate(() => {
    const edit = document.querySelector("button[aria-label='Edit this file']");
    if (!edit) return false;
    edit.click();
    return true;
  });
  check(editing, "the reader offers an edit affordance for a text file");
  await wait(600);

  const typed = await page.evaluate(({ mark }) => {
    const area = document.querySelector("textarea[aria-label='File contents']");
    if (!area) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, `${area.value}\n${mark}\n`);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return area.value.length;
  }, { mark: marker });
  check(typed !== null, "the editor exposes the file's text");
  await wait(300);

  const saved = await page.evaluate(() => {
    const save = document.querySelector("button[aria-label='Save this file']");
    if (!save) return false;
    save.click();
    return true;
  });
  check(saved, "a save control appears once the buffer is dirty");
  await wait(1500);
  await shot("03-editor");

  const onDisk = read(join(FIXTURE, FIXTURE_FILE), "utf8");
  check(onDisk.includes(marker), "the edit reached the file on disk");

  // ---- @ mentions ----------------------------------------------------------
  // Typed on a real keyboard and chosen with a real mouse. A programmatic
  // `.click()` skips mousedown, and a synthetic input event skips the keydown
  // ordering — the two places this feature actually breaks.
  await goto("/board");
  await wait(1500);
  await page.focus("textarea[aria-label='Prompt the lead agent']");
  await page.keyboard.type(`look at @${mentionQuery}`);
  await wait(900);
  const picker = await page.evaluate(() => {
    const list = document.querySelector("[role='listbox'][aria-label='Mention a file']");
    return list ? [...list.querySelectorAll("[role='option']")].map((o) => o.textContent.trim()) : null;
  });
  check(Array.isArray(picker) && picker.length > 0, "typing @ opens the file picker");
  check((picker ?? []).some((p) => p.includes(FIXTURE_MENTION)), "and it offers a real path from the workspace", String(picker));
  await shot("04-mentions");

  await (await page.$("[role='option']")).click();
  await wait(600);
  const clicked = await page.evaluate(() => document.querySelector("textarea[aria-label='Prompt the lead agent']").value);
  check(clicked.includes(`@${FIXTURE_MENTION} `), "clicking one splices the path into the prompt", clicked);

  // Enter chooses a file. It must not also send the prompt — the picker's state
  // update flushes synchronously, so a guard that reads it downstream is already
  // stale by the time the composer's own handler runs.
  await page.keyboard.type(`and @${mentionQuery}`);
  await wait(900);
  await page.keyboard.press("Enter");
  await wait(800);
  const typed2 = await page.evaluate(() =>
    document.querySelector("textarea[aria-label='Prompt the lead agent']")?.value ?? null);
  check(typed2 !== null, "Enter on the picker did not submit the prompt", `url ${page.url()}`);
  check((typed2 ?? "").split(`@${FIXTURE_MENTION} `).length === 3, "and it inserted the highlighted file again", String(typed2));

  // With nothing matching, Enter must still send — otherwise an `@` typo makes
  // the composer look broken.
  await page.evaluate(() => {
    const area = document.querySelector("textarea[aria-label='Prompt the lead agent']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, "");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.keyboard.type("nothing matches @zzzqqq");
  await wait(700);
  check(
    await page.evaluate(() => !document.querySelector("[role='option']")),
    "a query that matches nothing offers no options",
  );
} finally {
  // Leave the fixture repository as it was found.
  try {
    const p = join(FIXTURE, FIXTURE_FILE);
    writeFileSync(p, read(p, "utf8").replace(/\n<!-- e2e \d+ -->\n/g, ""));
  } catch { /* nothing to restore */ }
  await browser.close();
}

process.exit(state.failures ? 1 : 0);
