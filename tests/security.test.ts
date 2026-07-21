import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { redactText, redactValue } from "../lib/redact";

const token = "a".repeat(43);

test("redacts known and structural secrets", () => {
  assert.equal(redactText(`Bearer ${token}`), "[REDACTED]");
  assert.deepEqual(redactValue({ apiKey: token, nested: `token-${token}` }), { apiKey: "[REDACTED]", nested: "[REDACTED]" });
});

test("rejects invalid hosts before authentication", () => {
  process.env.NEXOTAO_SESSION_TOKEN = token;
  process.env.NEXOTAO_ALLOWED_HOST = "127.0.0.1:4319";
  const req = new NextRequest("http://evil.test/api/config", { headers: { host: "evil.test" } });
  assert.equal(proxy(req).status, 403);
});

test("requires a session and rejects cross-origin mutations", () => {
  process.env.NEXOTAO_SESSION_TOKEN = token;
  process.env.NEXOTAO_ALLOWED_HOST = "127.0.0.1:4319";
  const unauthenticated = new NextRequest("http://127.0.0.1:4319/api/config", { headers: { host: "127.0.0.1:4319" } });
  assert.equal(proxy(unauthenticated).status, 401);

  const crossOrigin = new NextRequest("http://127.0.0.1:4319/api/config", {
    method: "POST",
    headers: { host: "127.0.0.1:4319", origin: "https://evil.test", cookie: `nexotao_session=${token}`, "content-length": "2" },
    body: "{}",
  });
  assert.equal(proxy(crossOrigin).status, 403);
});

test("enforces mutation request size", () => {
  process.env.NEXOTAO_SESSION_TOKEN = token;
  process.env.NEXOTAO_ALLOWED_HOST = "127.0.0.1:4319";
  process.env.NEXOTAO_MAX_REQUEST_BYTES = "10";
  const req = new NextRequest("http://127.0.0.1:4319/api/config", {
    method: "POST",
    headers: { host: "127.0.0.1:4319", origin: "http://127.0.0.1:4319", cookie: `nexotao_session=${token}`, "content-length": "11" },
    body: "01234567890",
  });
  assert.equal(proxy(req).status, 413);
});
