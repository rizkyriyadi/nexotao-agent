import { redactValue } from "./redact";

export const MAX_RUN_EVENT_BYTES = 64 * 1024;
export const MAX_RUN_EVENT_STRING = 16 * 1024;
export const TERMINAL_RUN_EVENT_TYPES = new Set(["success", "failure", "cancellation", "cancelled"]);

export type DurableRunEvent = {
  runId: string;
  seq: number;
  type: string;
  redactedPayload: unknown;
  createdAt: number;
};

export class RunEventDomainError extends Error {
  constructor(readonly code: "terminal" | "invalid_cursor" | "not_found", message: string) {
    super(message);
  }
}

export function isTerminalRunEvent(type: string) {
  return TERMINAL_RUN_EVENT_TYPES.has(type);
}

function truncate(value: unknown, depth = 0): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[unsupported ${typeof value}]`;
  if (typeof value === "string") {
    if (value.length <= MAX_RUN_EVENT_STRING) return value;
    return `${value.slice(0, MAX_RUN_EVENT_STRING)}\n… [truncated ${value.length - MAX_RUN_EVENT_STRING} characters]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[truncated: maximum depth]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => truncate(item, depth + 1));
    if (value.length > 100) items.push(`[truncated ${value.length - 100} items]`);
    return items;
  }
  const entries = Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, 100)) out[key] = truncate(item, depth + 1);
  if (entries.length > 100) out._truncatedKeys = entries.length - 100;
  return out;
}

/** Secrets are removed before payloads reach SQLite. Oversized tool inputs and
 * outputs are replaced with a bounded preview so replay cannot exhaust memory. */
export function sanitizeRunEventPayload(payload: unknown): unknown {
  const safe = truncate(redactValue(payload));
  const encoded = JSON.stringify(safe) ?? "null";
  if (Buffer.byteLength(encoded, "utf8") <= MAX_RUN_EVENT_BYTES) return safe;
  const preview = encoded.slice(0, Math.floor(MAX_RUN_EVENT_BYTES / 4));
  return { preview, truncated: true, originalBytes: Buffer.byteLength(encoded, "utf8") };
}

type Subscriber = (event: DurableRunEvent) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function publishRunEvent(event: DurableRunEvent) {
  for (const subscriber of subscribers.get(event.runId) ?? []) subscriber(event);
}

export function subscribeRunEvents(runId: string, subscriber: Subscriber) {
  const set = subscribers.get(runId) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(runId, set);
  return () => {
    set.delete(subscriber);
    if (!set.size) subscribers.delete(runId);
  };
}

export function parseRunEventCursor(value: string | null): number {
  if (!value) return 0;
  const cursor = Number(value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RunEventDomainError("invalid_cursor", "Event cursor must be a non-negative integer");
  return cursor;
}

export function encodeRunEvent(event: DurableRunEvent) {
  const data = JSON.stringify({ runId: event.runId, seq: event.seq, type: event.type, payload: event.redactedPayload, createdAt: event.createdAt });
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}
