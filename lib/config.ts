// Local single-user config. Persisted on the user's machine (~/.nexotao).
import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";

export type Config = {
  apiKey?: string;
  model?: string;
  onboarded?: boolean;
  activeProjectId?: string | null;
};

export const DIR = path.join(os.homedir(), ".nexotao");
const FILE = path.join(DIR, "config.json");

export function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
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
  await fs.writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function publicView(c: Config) {
  return {
    onboarded: !!c.onboarded,
    hasKey: !!c.apiKey,
    keyHint: c.apiKey ? `sk-nexo-••••${c.apiKey.slice(-4)}` : null,
    model: c.model ?? null,
    activeProjectId: c.activeProjectId ?? null,
  };
}
