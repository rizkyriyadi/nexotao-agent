#!/usr/bin/env node
// `nexotao` — boots the local UI and opens the browser. Config lives in ~/.nexotao.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "4319";
const numericPort = Number(port);
if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error("PORT must be between 1 and 65535");
const host = "127.0.0.1";
const url = "http://" + host + ":" + port;
const sessionToken = process.env.NEXOTAO_SESSION_TOKEN || randomBytes(32).toString("base64url");
if (sessionToken.length < 32) throw new Error("NEXOTAO_SESSION_TOKEN must be at least 32 characters");

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "-p", port, "-H", host], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOSTNAME: host, NEXOTAO_ALLOWED_HOST: host + ":" + port, NEXOTAO_SESSION_TOKEN: sessionToken },
});

function openBrowser(u) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", u] : [u];
  try {
    const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
    opener.once("error", () => console.warn("  Could not open a browser. Open " + url + " manually.\n"));
    opener.unref();
  } catch {
    console.warn("  Could not open a browser. Open " + url + " manually.\n");
  }
}

let opened = false;
function poll() {
  http
    .get(url, () => {
      if (opened) return;
      opened = true;
      console.log(`\n  Nexotao Agents → ${url}\n`);
      if (process.env.NEXOTAO_NO_OPEN !== "1") openBrowser(url + "/?session_token=" + encodeURIComponent(sessionToken));
    })
    .on("error", () => setTimeout(poll, 400));
}
setTimeout(poll, 900);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
