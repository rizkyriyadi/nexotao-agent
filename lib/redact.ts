const TOKEN_PATTERNS = [
  /\b(?:sk|key|token|tvly)-[A-Za-z0-9._-]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /\b(api[_-]?key|access[_-]?token|authorization)\b\s*[:=]\s*["']?[^\s,"']+/gi,
];

export function redactText(value: unknown, secrets: Array<string | undefined> = []): string {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

export function redactValue<T>(value: T, secrets: Array<string | undefined> = []): T {
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = /(?:api.?key|token|authorization|secret|password)/i.test(key)
        ? "[REDACTED]"
        : redactValue(item, secrets);
    }
    return out as T;
  }
  return value;
}

export function safeError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : error);
}
