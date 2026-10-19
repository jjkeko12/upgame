import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Optional HTTP Basic auth. Enabled when AUTH_PASSWORD is set (username from
 * AUTH_USERNAME, default "admin"). Browsers cache the credentials after the
 * first prompt, so the UI needs no login screen. Returns a response to send
 * when the request is not authorised, otherwise null.
 */
export function requireAuth(request: Request): NextResponse | null {
  const password = process.env.AUTH_PASSWORD;
  if (!password) return null;

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      const expectedUser = process.env.AUTH_USERNAME || "admin";
      if (safeEqual(user, expectedUser) && safeEqual(pass, password)) return null;
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Game Library", charset="UTF-8"' },
  });
}

/**
 * Blocks cross-site and sandboxed-iframe ("null" origin) requests to routes
 * that change state. Browsers always send Origin on POST/DELETE; non-browser
 * clients (curl) send none and are allowed through to the auth check.
 */
export function rejectCrossSite(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
  }

  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || request.headers.get("host");
  if (originHost !== host) {
    return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
  }
  return null;
}

/** Guard for POST/DELETE routes: same-origin check, then auth. */
export function guardMutation(request: Request): NextResponse | null {
  return rejectCrossSite(request) ?? requireAuth(request);
}

/** Guard for read routes that list or inspect games. */
export function guardRead(request: Request): NextResponse | null {
  return requireAuth(request);
}
