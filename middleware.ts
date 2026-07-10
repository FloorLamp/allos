import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from "./lib/session-cookie";

// Coarse, non-authoritative auth gate. The Edge runtime can't open SQLite, so
// this only checks for the *presence* of a session cookie: it bounces obviously
// unauthenticated requests early and slides the cookie's browser lifetime. The
// REAL check — that the cookie maps to a live, unexpired session — is
// requireSession()/getCurrentSession() in Node code (the (app) layout and each
// protected route/action). This design is therefore unaffected by the middleware
// auth-bypass in CVE-2025-29927 (the app is separately patched to Next ≥14.2.25),
// since bypassing middleware only skips a redirect, never the authoritative check.
//
// NOTE: the cookie NAME + Secure flag come from lib/session-cookie.ts, a
// dependency-free module that both this Edge middleware and the Node auth layer
// (lib/auth.ts) import, so the `__Host-` prefix decision can never drift between
// the two. Only the TTL is duplicated here (a trivial constant).
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

// Reachable without a session. Everything else requires the cookie.
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/health",
  "/api/integrations/health-connect/ingest", // token-authenticated push ingest
  "/api/telegram/webhook", // secret-header authenticated
  // NOTE: /api/integrations/strava/callback is intentionally NOT public — the
  // OAuth redirect carries the session cookie (SameSite=Lax), and the handler
  // binds tokens to the session's active profile, so it requires a live session.
  // App-router icon routes referenced by the login page's <head>.
  "/icon.svg",
  "/apple-icon",
  "/favicon.ico",
  // PWA. These must load without a session: a standalone launch
  // starts unauthenticated, the SW registers on the login page, and the offline
  // fallback has to render when there's no live session at all. None expose PHI —
  // the manifest and offline page are static, and the worker's caching policy
  // never stores auth-gated responses.
  "/manifest.webmanifest",
  "/sw.js",
  "/offline",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // next/og serves the apple icon under a hashed child path (/apple-icon/<id>).
  if (pathname.startsWith("/apple-icon")) return true;
  // Unauthenticated, read-only "medical passport" share links. The
  // path carries an unguessable token; the handler (app/share/[token]) validates
  // it against the DB (hash lookup + expiry/revocation) and 404s on any miss.
  if (pathname.startsWith("/share/")) return true;
  // Token-authenticated, read-only calendar subscribe feed (.ics). The path
  // carries an unguessable per-profile token; the handler (app/api/calendar/
  // [token]) hashes it, resolves the owning profile, and 404s on any miss/
  // disabled feed — no session needed (a calendar client has none).
  if (pathname.startsWith("/api/calendar/")) return true;
  return false;
}

// A shared passport is sensitive, unauthenticated content: never let a browser or
// proxy cache it (a revoked/expired link must stop working immediately), and never
// let it be MIME-sniffed. Applied to /share/* responses.
function withShareHeaders(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, must-revalidate");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

// Re-set the session cookie with a fresh 30-day max-age (sliding refresh).
// Server Components can't set cookies, so this is where the browser
// lifetime is extended on each navigation.
function withSlidingCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  if (isPublic(pathname)) {
    // Share links are public but must never be cached or associated with a
    // session — serve them with hardened headers and without touching the cookie.
    if (pathname.startsWith("/share/")) {
      return withShareHeaders(NextResponse.next());
    }
    // Keep sliding an authenticated user's cookie even on public paths.
    return token
      ? withSlidingCookie(NextResponse.next(), token)
      : NextResponse.next();
  }

  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  return withSlidingCookie(NextResponse.next(), token);
}

export const config = {
  // Run on everything except Next's internal static/image/data assets. Metadata
  // icon routes live at the root and are handled by the allowlist above.
  matcher: ["/((?!_next/static|_next/image|_next/data).*)"],
};
