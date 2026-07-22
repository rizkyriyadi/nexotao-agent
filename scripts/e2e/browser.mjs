// Resolves a Chrome/Chromium executable for puppeteer-core, without bundling one.
// Order: PUPPETEER_EXECUTABLE_PATH -> project .cache/puppeteer -> ~/.cache/puppeteer.
// Install one with: npx @puppeteer/browsers install chrome-headless-shell@stable
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function walk(dir, matches, depth = 6) {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let info;
    try { info = statSync(full); } catch { continue; }
    if (info.isFile() && matches.includes(entry)) return full;
    if (info.isDirectory()) { const found = walk(full, matches, depth - 1); if (found) return found; }
  }
  return null;
}

export function resolveBrowser() {
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const names = process.platform === "win32"
    ? ["chrome-headless-shell.exe", "chrome.exe"]
    : ["chrome-headless-shell", "chrome"];
  const roots = [
    join(process.cwd(), ".cache", "puppeteer"),
    join(homedir(), ".cache", "puppeteer"),
  ];
  for (const root of roots) { const found = walk(root, names); if (found) return found; }
  return null;
}
