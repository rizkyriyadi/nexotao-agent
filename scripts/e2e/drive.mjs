// A small browser driver for hand-testing the app the way a user meets it:
// authenticate once, navigate, screenshot, read text. Kept separate from the
// scripted suites so an exploratory session doesn't have to reimplement the
// session-cookie dance every time.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./browser.mjs";

// The app only answers requests whose Host is the configured one, and Chrome
// refuses a manually-set Host header — so the browser is told to resolve that
// hostname to the local server instead. The URL bar says the real host; the
// bytes come from the process on this box.
export const HOST = process.env.NEXOTAO_ALLOWED_HOST ?? "human.nexotao.com";
export const TARGET = process.env.NEXOTAO_TARGET ?? "127.0.0.1:4319";
export const ORIGIN = process.env.NEXOTAO_ORIGIN ?? `http://${HOST}`;

export function sessionToken() {
  const line = readFileSync(join(process.cwd(), ".env.runtime"), "utf8")
    .split("\n").find((l) => l.startsWith("NEXOTAO_SESSION_TOKEN="));
  if (!line) throw new Error("no NEXOTAO_SESSION_TOKEN in .env.runtime");
  return line.slice("NEXOTAO_SESSION_TOKEN=".length).trim();
}

export async function openSession(shotDir) {
  const executablePath = resolveBrowser();
  if (!executablePath) throw new Error("no chrome; npx @puppeteer/browsers install chrome-headless-shell@stable");
  const dir = join(process.cwd(), "e2e-artifacts", shotDir);
  mkdirSync(dir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    args: [
      "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--host-resolver-rules=MAP ${HOST} ${TARGET.split(":")[0]}`,
      `--host-rules=MAP ${HOST} ${TARGET}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

  const goto = async (path) => {
    await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2", timeout: 60_000 });
  };
  // First navigation carries the token, which sets the httpOnly cookie.
  await goto(`/board?session_token=${sessionToken()}`);

  const shot = async (name) => {
    const file = join(dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`   shot: ${file}`);
    return file;
  };
  const text = () => page.evaluate(() => document.body.innerText);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  return { browser, page, goto, shot, text, wait, dir };
}

export function checker() {
  const state = { failures: 0 };
  const check = (ok, label, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) state.failures += 1;
    return ok;
  };
  return { check, state };
}
