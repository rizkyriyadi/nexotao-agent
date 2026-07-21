import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: node scripts/release-smoke.mjs <package.tgz>");
const root = await mkdtemp(join(tmpdir(), "nexotao-smoke-"));
const prefix = join(root, "install");
const port = String(4400 + Math.floor(Math.random() * 400));
const token = "smoke-" + "x".repeat(40);

function command(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(child) : reject(new Error(`${bin} exited ${code}`)));
  });
}

try {
  await command("npm", ["install", "--global", "--prefix", prefix, archive]);
  const bin = join(prefix, "bin", process.platform === "win32" ? "nexotao.cmd" : "nexotao");
  const app = spawn(bin, [], {
    env: { ...process.env, PORT: port, NEXOTAO_SESSION_TOKEN: token, NEXOTAO_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  app.stdout.on("data", (chunk) => { output += chunk; });
  app.stderr.on("data", (chunk) => { output += chunk; });

  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { cookie: `nexotao_session=${token}` } });
      if (response.ok && (await response.json()).ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error(`Installed package did not become healthy:\n${output}`);

  app.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed package did not shut down")), 7000);
    app.once("exit", () => { clearTimeout(timer); resolve(); });
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
