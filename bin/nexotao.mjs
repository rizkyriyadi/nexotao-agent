#!/usr/bin/env node
// `nexotao` — boots the local UI and opens the browser. Config lives in ~/.nexotao.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "4319";
const url = `http://localhost:${port}`;

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "-p", port], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: port },
});

function openBrowser(u) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", u] : [u];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open the URL manually */
  }
}

let opened = false;
function poll() {
  http
    .get(url, () => {
      if (opened) return;
      opened = true;
      console.log(`\n  Nexotao Agents → ${url}\n`);
      openBrowser(url);
    })
    .on("error", () => setTimeout(poll, 400));
}
setTimeout(poll, 900);

process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(0); });
child.on("exit", (code) => process.exit(code ?? 0));
