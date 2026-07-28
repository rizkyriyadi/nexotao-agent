import { NextRequest, NextResponse } from "next/server";

const COOKIE = "nexotao_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function expectedHost() {
  return process.env.NEXOTAO_ALLOWED_HOST || `127.0.0.1:${process.env.PORT || "4319"}`;
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
  if (host !== allowedHost) return securityHeaders(NextResponse.json({ error: "Invalid Host" }, { status: 403 }));

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
    return securityHeaders(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
  }

  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.headers.get("origin");
    if (origin !== `${expectedScheme(req)}://${allowedHost}`) return securityHeaders(NextResponse.json({ error: "Invalid Origin" }, { status: 403 }));
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
