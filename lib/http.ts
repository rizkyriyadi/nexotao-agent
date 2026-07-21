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

export function jsonError(error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  return NextResponse.json({ error: status === 500 ? "Internal server error" : safeError(error) }, { status });
}
