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

test("accepts an https origin behind a TLS-terminating proxy", () => {
  process.env.NEXOTAO_SESSION_TOKEN = token;
  process.env.NEXOTAO_ALLOWED_HOST = "human.nexotao.com";
  delete process.env.NEXOTAO_MAX_REQUEST_BYTES;
  const headers = {
    host: "human.nexotao.com",
    origin: "https://human.nexotao.com",
    cookie: `nexotao_session=${token}`,
    "content-length": "2",
    // What nginx adds; the request itself still arrives over plain http.
    "x-forwarded-proto": "https",
  };
  const req = new NextRequest("http://human.nexotao.com/api/config", { method: "POST", headers, body: "{}" });
  assert.equal(proxy(req).status, 200);

  // Without the header the app is being reached directly, so an https origin
  // is genuinely foreign and must still be refused.
  const { "x-forwarded-proto": _omitted, ...direct } = headers;
  const spoofed = new NextRequest("http://human.nexotao.com/api/config", { method: "POST", headers: direct, body: "{}" });
  assert.equal(spoofed.headers.get("x-forwarded-proto"), null);
  assert.equal(proxy(spoofed).status, 403);
});

test("the token handshake keeps the browser on https and marks the cookie secure", () => {
  process.env.NEXOTAO_SESSION_TOKEN = token;
  process.env.NEXOTAO_ALLOWED_HOST = "human.nexotao.com";
  const req = new NextRequest(`http://human.nexotao.com/?session_token=${token}`, {
    headers: { host: "human.nexotao.com", "x-forwarded-proto": "https" },
  });
  const res = proxy(req);
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "https://human.nexotao.com/");
  assert.match(res.headers.get("set-cookie") ?? "", /Secure/);

  // The local flow is plain http, where a Secure cookie would be dropped.
  process.env.NEXOTAO_ALLOWED_HOST = "127.0.0.1:4319";
  const local = new NextRequest(`http://127.0.0.1:4319/?session_token=${token}`, { headers: { host: "127.0.0.1:4319" } });
  const localRes = proxy(local);
  // Asserting the scheme, not the full URL: NextRequest normalises the 127.0.0.1
  // authority to localhost, which is irrelevant to what this test is about.
  assert.match(localRes.headers.get("location") ?? "", /^http:\/\//);
  assert.doesNotMatch(localRes.headers.get("set-cookie") ?? "", /Secure/);
});

test("treats localhost and 127.0.0.1 as the same local host", () => {
  process.env.NEXOTAO_SESSION_TOKEN = token;
  process.env.NEXOTAO_ALLOWED_HOST = "127.0.0.1:4319";
  delete process.env.NEXOTAO_MAX_REQUEST_BYTES;

  // The README tells people to open `localhost:4319`; the CLI advertises
  // `127.0.0.1:4319`. Both have to reach the same app.
  // A browser on the alias holds no cookie for it — the session was minted for
  // `127.0.0.1` — so a plain navigation is sent to the canonical host, where
  // that cookie applies, rather than being refused.
  const named = new NextRequest("http://localhost:4319/board", { headers: { host: "localhost:4319" } });
  const redirect = proxy(named);
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "http://127.0.0.1:4319/board");

  const write = new NextRequest("http://localhost:4319/api/config", {
    method: "POST",
    headers: { host: "localhost:4319", origin: "http://localhost:4319", cookie: `nexotao_session=${token}`, "content-length": "2" },
    body: "{}",
  });
  assert.equal(proxy(write).status, 200);

  // A different port is a different server, alias or not.
  const otherPort = new NextRequest("http://localhost:9999/api/config", { headers: { host: "localhost:9999" } });
  assert.equal(proxy(otherPort).status, 403);

  // And the alias must not let a foreign origin drive that tab.
  const foreign = new NextRequest("http://localhost:4319/api/config", {
    method: "POST",
    headers: { host: "localhost:4319", origin: "http://127.0.0.1:9999", cookie: `nexotao_session=${token}`, "content-length": "2" },
    body: "{}",
  });
  assert.equal(proxy(foreign).status, 403);
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
