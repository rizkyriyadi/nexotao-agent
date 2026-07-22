// Opt-in, redacted crash/performance telemetry. OFF by default. Nothing is
// collected unless the user opts in (Settings toggle -> config.telemetry, or the
// NEXOTAO_TELEMETRY env var). Every payload passes through the redactor and only
// carries a redacted error message plus numeric performance counters — never
// prompts, code, file contents, API keys, or arbitrary context. See docs/telemetry.md.
import { promises as fs } from "node:fs";
import path from "node:path";
import { DIR, type Config } from "./config";
import { redactText } from "./redact";

export type TelemetryKind = "crash" | "performance";

export type TelemetryInput = {
  kind: TelemetryKind;
  name: string;
  durationMs?: number;
  error?: unknown;
  /** Optional low-cardinality tags. Values are coerced to redacted scalars. */
  tags?: Record<string, string | number | boolean>;
};

export type TelemetryEvent = {
  kind: TelemetryKind;
  name: string;
  at: number;
  durationMs?: number;
  message?: string;
  tags?: Record<string, string | number | boolean>;
};

const MESSAGE_CAP = 500;
const TRUTHY = new Set(["1", "on", "true", "yes"]);
const FALSY = new Set(["0", "off", "false", "no"]);

/** Opt-in resolution. The env var wins over config so an operator can force the
 * feature on or off for a run; absent both, telemetry stays disabled. */
export function isTelemetryEnabled(config: Pick<Config, "telemetry"> = {}, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.NEXOTAO_TELEMETRY?.trim().toLowerCase();
  if (raw && TRUTHY.has(raw)) return true;
  if (raw && FALSY.has(raw)) return false;
  return config.telemetry === true;
}

/** Builds a redacted, PII-free event. Pure — safe to unit test. */
export function buildTelemetryEvent(input: TelemetryInput, options: { secrets?: Array<string | undefined>; now: number }): TelemetryEvent {
  const secrets = options.secrets ?? [];
  const event: TelemetryEvent = { kind: input.kind, name: redactText(input.name, secrets).slice(0, 120), at: options.now };
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) event.durationMs = Math.max(0, Math.round(input.durationMs));
  if (input.error !== undefined) {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    event.message = redactText(message, secrets).slice(0, MESSAGE_CAP);
  }
  if (input.tags) {
    const tags: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input.tags)) {
      if (/(?:key|token|secret|password|authorization|path|email|prompt|content)/i.test(key)) continue; // drop sensitive tags outright
      tags[key] = typeof value === "string" ? redactText(value, secrets).slice(0, 120) : value;
    }
    if (Object.keys(tags).length) event.tags = tags;
  }
  return event;
}

// Resolve the data directory at call time so an override (or test) takes effect
// even after this module was imported.
const dataDir = () => (process.env.NEXOTAO_DATA_DIR ? path.resolve(process.env.NEXOTAO_DATA_DIR) : DIR);
export const telemetrySinkPath = () => path.join(dataDir(), "telemetry.jsonl");

/** Records an event iff telemetry is enabled. Returns whether it was emitted and
 * the exact redacted payload (for surfacing/preview). Local-first: appends to a
 * 0600 sink; a remote endpoint is only contacted when explicitly configured. */
export async function recordTelemetry(
  input: TelemetryInput,
  options: { config?: Pick<Config, "telemetry">; env?: Record<string, string | undefined>; now?: number; secrets?: Array<string | undefined> } = {},
): Promise<{ emitted: boolean; event?: TelemetryEvent }> {
  const env = options.env ?? process.env;
  if (!isTelemetryEnabled(options.config ?? {}, env)) return { emitted: false };
  const event = buildTelemetryEvent(input, { secrets: options.secrets, now: options.now ?? Date.now() });
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = telemetrySinkPath();
  await fs.appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  const endpoint = env.NEXOTAO_TELEMETRY_ENDPOINT;
  if (endpoint) {
    try {
      await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
    } catch { /* telemetry must never break the app; local sink already has it */ }
  }
  return { emitted: true, event };
}
