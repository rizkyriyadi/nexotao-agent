// Local single-user config. Persisted on the user's machine (~/.nexotao).
import { promises as fs } from "fs";
import { chmodSync, existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";

export type Config = {
  apiKey?: string;
  model?: string;
  onboarded?: boolean;
  activeProjectId?: string | null;
  searchApiKey?: string; // optional Tavily key for reliable web search
};

export const DIR = process.env.NEXOTAO_DATA_DIR
  ? path.resolve(process.env.NEXOTAO_DATA_DIR)
  : path.join(os.homedir(), ".nexotao");
const FILE = path.join(DIR, "config.json");

export function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(DIR, 0o700); } catch { /* surfaced by the write */ }
}

export async function getConfig(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  ensureDir();
  const next = { ...(await getConfig()), ...patch };
  await fs.writeFile(FILE, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await Promise.all([fs.chmod(DIR, 0o700), fs.chmod(FILE, 0o600)]);
  return next;
}

export function publicView(c: Config) {
  return {
    onboarded: !!c.onboarded,
    hasKey: !!c.apiKey,
    model: c.model ?? null,
    activeProjectId: c.activeProjectId ?? null,
    hasSearchKey: !!c.searchApiKey,
  };
}
