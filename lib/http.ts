import { NextResponse } from "next/server";
import { safeError } from "./redact";

export class HttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError("Content-Type must be application/json", 415);
  }
  let body: unknown;
  try { body = await req.json(); } catch { throw new HttpError("Malformed JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError("JSON body must be an object");
  return body as Record<string, unknown>;
}

export function stringField(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const value = body[key];
  if (value === undefined && !opts.required) return undefined;
  if (typeof value !== "string" || (opts.required && !value.trim())) throw new HttpError(`${key} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > (opts.max ?? 20_000)) throw new HttpError(`${key} is too long`);
  return trimmed;
}

export function stringsField(body: Record<string, unknown>, key: string, fallback: string[] = []) {
  const value = body[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(`${key} must be an array of strings`);
  return value as string[];
}

export function objectField(body: Record<string, unknown>, key: string, fallback: Record<string, unknown> = {}) {
  const value = body[key];
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(`${key} must be an object`);
  return value as Record<string, unknown>;
}

/** `undefined` means "leave alone" and `null` means "clear it", so a PATCH can
 *  distinguish an omitted field from one the user emptied. Empty string is
 *  treated as absent because that is what an emptied form input sends. */
export function numberField(body: Record<string, unknown>, key: string, fallback: number | null) {
  const value = body[key];
  if (value === undefined || value === "") return fallback;
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(`${key} must be a number`);
  return parsed;
}

export function booleanField(body: Record<string, unknown>, key: string, fallback: boolean) {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(`${key} must be a boolean`);
  return value;
}

export function jsonError(error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  return NextResponse.json({ error: status === 500 ? "Internal server error" : safeError(error) }, { status });
}
