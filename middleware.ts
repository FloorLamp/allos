import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from "./lib/session-cookie";
import { buildCsp, generateNonce } from "./lib/csp";

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

// Content-Security-Policy (issue #595, step 3). The full CSP is built and set
// HERE, per-request, because script-src carries a per-request nonce — next.config
// no longer declares a Content-Security-Policy header at all, so lib/csp.ts is the
// single source of truth (the enforced policy applies to every document route this
// middleware matches; static _next assets, excluded by the matcher, are governed
// by the CSP on the document that loads them). See lib/csp.ts for the
// script-src/style-src/dev-mode reasoning.
const IS_DEV = process.env.NODE_ENV !== "production";

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

  // Build the per-request nonce + CSP once, then stamp it onto EVERY response we
  // return below (share, redirect, 401, normal) so no route escapes the policy.
  const nonce = generateNonce();
  const csp = buildCsp(nonce, IS_DEV);

  // Thread the nonce into the REQUEST headers for the document routes: `x-nonce`
  // is read by app/layout.tsx (theme-boot <script nonce>), and the request-header
  // Content-Security-Policy is what Next parses to stamp its own inline bootstrap
  // scripts with the same nonce. Cloned so we don't mutate the incoming headers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const passNonce = { request: { headers: requestHeaders } };

  // Apply the response-header CSP to any response before it leaves middleware.
  const withCsp = (res: NextResponse): NextResponse => {
    res.headers.set("content-security-policy", csp);
    return res;
  };

  if (isPublic(pathname)) {
    // Share links are public but must never be cached or associated with a
    // session — serve them with hardened headers and without touching the cookie.
    // The CSP still rides along (it does not weaken withShareHeaders' stricter
    // Referrer-Policy/cache posture — the two header sets are disjoint).
    if (pathname.startsWith("/share/")) {
      return withCsp(withShareHeaders(NextResponse.next(passNonce)));
    }
    // Keep sliding an authenticated user's cookie even on public paths.
    return withCsp(
      token
        ? withSlidingCookie(NextResponse.next(passNonce), token)
        : NextResponse.next(passNonce)
    );
  }

  if (!token) {
    if (pathname.startsWith("/api/")) {
      return withCsp(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname + search);
    return withCsp(NextResponse.redirect(url));
  }

  return withCsp(withSlidingCookie(NextResponse.next(passNonce), token));
}

export const config = {
  // Run on everything except Next's internal static/image/data assets. Metadata
  // icon routes live at the root and are handled by the allowlist above.
  matcher: ["/((?!_next/static|_next/image|_next/data).*)"],
};
