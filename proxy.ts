import { NextRequest, NextResponse } from "next/server";

const COOKIE = "nexotao_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function expectedHost() {
  return process.env.NEXOTAO_ALLOWED_HOST || `127.0.0.1:${process.env.PORT || "4319"}`;
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
    const clean = req.nextUrl.clone();
    clean.searchParams.delete("session_token");
    const response = NextResponse.redirect(clean);
    response.cookies.set(COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 12 * 60 * 60 });
    return securityHeaders(response);
  }

  if (req.cookies.get(COOKIE)?.value !== token) {
    return securityHeaders(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
  }

  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.headers.get("origin");
    if (origin !== `http://${allowedHost}`) return securityHeaders(NextResponse.json({ error: "Invalid Origin" }, { status: 403 }));
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
