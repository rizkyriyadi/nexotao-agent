// Drives the three things the user asked for: a dock you can drag wider, code
// that comes up coloured, and a soft dark mode on every page.
//
// Usage: NEXOTAO_TARGET=127.0.0.1:4322 node scripts/e2e-theme-editor.mjs
import { mkdirSync, readFileSync as read } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./e2e/browser.mjs";
import { checker } from "./e2e/drive.mjs";

const TARGET = process.env.NEXOTAO_TARGET ?? "127.0.0.1:4322";
const ORIGIN = `http://${TARGET}`;
// A code file the open workspace really contains — the colouring assertions
// need something with keywords in it.
const CODE_FILE = process.env.NEXOTAO_CODE_FILE ?? "";
if (!CODE_FILE) {
  console.error("usage: NEXOTAO_CODE_FILE=<a .js/.ts file name in the open project> node scripts/e2e-theme-editor.mjs");
  process.exit(2);
}
const token = read(join(process.cwd(), ".env.runtime"), "utf8")
  .split("\n").find((l) => l.startsWith("NEXOTAO_SESSION_TOKEN="))
  .slice("NEXOTAO_SESSION_TOKEN=".length).trim();

const dir = join(process.cwd(), "e2e-artifacts", "theme-editor");
mkdirSync(dir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: resolveBrowser(),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
const goto = (path) => page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2", timeout: 60_000 });
const shot = async (name) => { const f = join(dir, `${name}.png`); await page.screenshot({ path: f }); console.log(`   shot: ${f}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await goto(`/board?session_token=${token}`);
const { check, state } = checker();

const dockWidth = () => page.evaluate(() => {
  const aside = document.querySelector("aside");
  return aside ? Math.round(aside.getBoundingClientRect().width) : null;
});

try {
  // ---- resizing the dock ---------------------------------------------------
  await goto("/board");
  await wait(1500);
  const before = await dockWidth();
  check(before !== null && before > 0, "the dock has a measurable width", String(before));

  const handle = await page.$("[role='separator'][aria-label='Resize the workspace panel']");
  check(Boolean(handle), "it carries a resize handle");

  // A real pointer drag, not a synthetic event: the drag listens on `window`
  // for pointermove, which a dispatched MouseEvent on the handle never produces.
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x - 160, box.y + 300, { steps: 12 });
  await page.mouse.up();
  await wait(400);
  const after = await dockWidth();
  check(after > before + 100, "dragging it left widens the panel", `${before} → ${after}`);
  await shot("01-resized");

  // The width has to survive a reload, or it is a gesture rather than a setting.
  await goto("/board");
  await wait(1500);
  const reloaded = await dockWidth();
  check(Math.abs(reloaded - after) <= 2, "and the width is remembered across a reload", `${after} → ${reloaded}`);

  // Keyboard reach: a drag-only control is unusable without a pointer.
  await page.focus("[role='separator'][aria-label='Resize the workspace panel']");
  await page.keyboard.press("ArrowRight");
  await wait(300);
  const nudged = await dockWidth();
  check(nudged < reloaded, "arrow keys resize it too", `${reloaded} → ${nudged}`);

  // ---- syntax colouring ----------------------------------------------------
  const opened = await page.evaluate((name) => {
    const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
    if (!row) return false;
    row.click();
    return true;
  }, CODE_FILE);
  check(opened, "a code file opens from the tree", CODE_FILE);
  await wait(1500);

  // Distinct *rendered* colours are the assertion. Asserting on class names
  // would pass even if the stylesheet never defined them.
  const palette = await page.evaluate(() => {
    const pre = document.querySelector("pre");
    if (!pre) return null;
    const spans = [...pre.querySelectorAll("span")];
    return [...new Set(spans.map((s) => getComputedStyle(s).color))];
  });
  check(Array.isArray(palette) && palette.length >= 3,
    "the code renders in several distinct colours", String(palette));
  await shot("02-highlighted");

  // ---- dark mode -----------------------------------------------------------
  const toggle = "button[aria-label^='Theme:']";
  check(Boolean(await page.$(toggle)), "a theme control sits in the rail");

  const readTheme = () => page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
  }));
  const light = await readTheme();
  await page.click(toggle);
  await wait(500);
  const dark = await readTheme();
  // One press, not two. The app starts on "system", and a fixed
  // light → dark → system cycle sent the first press to "light" — the same
  // pixels, on a light-defaulting OS. That is the bug this asserts is gone, so
  // clicking until it goes dark would assert nothing.
  check(dark.dark && !light.dark, "one click on it turns the app dark");
  check(dark.bg !== light.bg && dark.fg !== light.fg, "and the page actually repaints", `${light.bg} → ${dark.bg}`);

  // "dark modenya yang soft" — the explicit ask. Pure black is what this rules
  // out, in both directions: not #000, and not white text either.
  const rgb = (s) => s.match(/\d+/g).map(Number);
  const [r, g, b] = rgb(dark.bg);
  check(r + g + b > 12 && r + g + b < 150, "the backdrop is a soft charcoal, not pure black", dark.bg);
  const [tr, tg, tb] = rgb(dark.fg);
  check(tr < 255 && tg < 255 && tb < 255, "and the text stops short of pure white", dark.fg);
  await shot("03-dark-board");

  // Every page, not just the one with the toggle on it.
  for (const path of ["/", "/work", "/agents", "/projects", "/settings", "/inbox", "/work/analytics"]) {
    await goto(path);
    await wait(900);
    const state = await readTheme();
    check(state.dark, `dark mode survives navigation to ${path}`, state.bg);
  }
  await shot("04-dark-work");

  // The preference has to outlive the tab, and must not flash light on the way
  // back — the class is set by a blocking script before first paint.
  await goto("/board");
  await wait(1200);
  check((await readTheme()).dark, "and it is still dark after a full reload");

  const early = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  check(early, "the theme class is present at first paint, so nothing flashes white");

  // Code has to stay readable in the dark, not just not-crash.
  await page.evaluate((name) => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)?.click();
  }, CODE_FILE);
  await wait(1500);
  const darkPalette = await page.evaluate(() => {
    const pre = document.querySelector("pre");
    return pre ? [...new Set([...pre.querySelectorAll("span")].map((s) => getComputedStyle(s).color))] : null;
  });
  check(Array.isArray(darkPalette) && darkPalette.length >= 3, "code is still coloured in dark mode", String(darkPalette));
  check(String(darkPalette) !== String(palette), "with a palette re-pointed for the dark backdrop");
  await shot("05-dark-code");
} finally {
  await browser.close();
}

process.exit(state.failures ? 1 : 0);
