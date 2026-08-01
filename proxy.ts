import { NextRequest, NextResponse } from "next/server";

const COOKIE = "nexotao_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function expectedHost() {
  return process.env.NEXOTAO_ALLOWED_HOST || `127.0.0.1:${process.env.PORT || "4319"}`;
}

/** Names that all reach the same loopback interface. The CLI binds `127.0.0.1`
 *  and advertises exactly that, but the README — and most people's muscle
 *  memory — says `localhost`, and a raw string comparison rejected the whole app
 *  with a 403 for anyone who typed the name instead of the address. */
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Split `host:port`, tolerating the brackets an IPv6 authority carries. Only a
 *  colon *after* the closing bracket separates a port. */
function splitHost(value: string) {
  const colon = value.lastIndexOf(":");
  if (colon > value.lastIndexOf("]")) return { name: value.slice(0, colon), port: value.slice(colon + 1) };
  return { name: value, port: "" };
}

/** Two authorities are the same origin for our purposes when they are equal, or
 *  when both name the loopback interface on the same port. Widening this to
 *  loopback aliases does not widen exposure: the server only listens there. */
function hostMatches(actual: string, allowed: string) {
  const a = splitHost(actual.toLowerCase());
  const b = splitHost(allowed.toLowerCase());
  if (a.name === b.name && a.port === b.port) return true;
  return a.port === b.port && LOOPBACK_NAMES.has(a.name) && LOOPBACK_NAMES.has(b.name);
}

/** The scheme the browser actually used. Behind a TLS-terminating reverse proxy
 *  the app itself only ever sees plain HTTP, so the origin a browser sends is
 *  `https://host` while the request arrives as HTTP — comparing against a
 *  hardcoded `http://` rejected every write with a 403. Only a proxy can set
 *  `x-forwarded-proto`; a direct local request has none and stays on http. */
function expectedScheme(req: NextRequest) {
  const forwarded = req.headers.get("x-forwarded-proto");
  // A proxy chain may append: take the first hop, the one the client spoke to.
  const scheme = forwarded?.split(",")[0]?.trim();
  return scheme === "https" ? "https" : "http";
}

/** An `Origin` is ours when its scheme is the one the browser spoke and its
 *  authority is the host this request already cleared. Parsed rather than
 *  string-compared so a value like `http://127.0.0.1:4319/` or a malformed one
 *  cannot slip through on a prefix. */
function originMatches(origin: string | null, scheme: string, host: string) {
  if (!origin) return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== `${scheme}:`) return false;
  return hostMatches(url.host, host);
}

function securityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") || "";
  const allowedHost = expectedHost();
  if (!hostMatches(host, allowedHost)) return securityHeaders(NextResponse.json({ error: "Invalid Host" }, { status: 403 }));

  const token = process.env.NEXOTAO_SESSION_TOKEN;
  if (!token || token.length < 32) return securityHeaders(NextResponse.json({ error: "Local session security is not configured" }, { status: 503 }));

  if (req.method === "GET" && req.nextUrl.searchParams.get("session_token") === token) {
    const scheme = expectedScheme(req);
    const clean = req.nextUrl.clone();
    clean.searchParams.delete("session_token");
    // Behind a TLS proxy the app sees http, so a cloned URL would bounce the
    // browser down to http:// and drop a `secure` cookie on the way.
    clean.protocol = `${scheme}:`;
    const response = NextResponse.redirect(clean);
    response.cookies.set(COOKIE, token, {
      httpOnly: true, sameSite: "strict", path: "/", maxAge: 12 * 60 * 60,
      // Only over TLS: a `secure` cookie is silently dropped on plain http,
      // which would lock out the local 127.0.0.1 flow.
      secure: scheme === "https",
    });
    return securityHeaders(response);
  }

  if (req.cookies.get(COOKIE)?.value !== token) {
    // Cookies are scoped per host name, so the session minted on `127.0.0.1`
    // is simply not sent to `localhost` — clearing the host gate above only
    // moved the lockout from 403 to 401. Send loopback aliases to the one host
    // the cookie was written for; arriving there the names match, so a missing
    // cookie falls through to the 401 below rather than bouncing forever.
    if (SAFE_METHODS.has(req.method) && host !== allowedHost) {
      const canonical = req.nextUrl.clone();
      canonical.host = allowedHost;
      canonical.protocol = `${expectedScheme(req)}:`;
      return securityHeaders(NextResponse.redirect(canonical));
    }
    return securityHeaders(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
  }

  if (!SAFE_METHODS.has(req.method)) {
    // Checked against the host the browser actually used, not the configured
    // one: both have to survive `hostMatches` above, and a page served from
    // `localhost` sends `Origin: http://localhost` — comparing that to the
    // configured `127.0.0.1` refused every write from a legitimate tab.
    if (!originMatches(req.headers.get("origin"), expectedScheme(req), host)) {
      return securityHeaders(NextResponse.json({ error: "Invalid Origin" }, { status: 403 }));
    }
    const rawLength = req.headers.get("content-length");
    const maxBytes = Number(process.env.NEXOTAO_MAX_REQUEST_BYTES || 8 * 1024 * 1024);
    if (!rawLength || !Number.isSafeInteger(Number(rawLength)) || Number(rawLength) < 0) {
      return securityHeaders(NextResponse.json({ error: "Content-Length is required" }, { status: 411 }));
    }
    if (Number(rawLength) > maxBytes) return securityHeaders(NextResponse.json({ error: "Request is too large" }, { status: 413 }));
  }

  return securityHeaders(NextResponse.next());
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
