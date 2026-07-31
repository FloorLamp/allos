// The middleware public-path allowlist (issue #985 extraction). Dependency-free and
// Edge-safe — the coarse middleware and a unit test both import it, so the set of
// session-free paths is tested without booting the Edge runtime, and additions
// (the forgot-password / set-password auth routes) can't silently diverge from the
// test. This is ONLY the coarse presence check; the authoritative session check is
// always requireSession()/getCurrentSession() in Node code (see middleware.ts).

// Reachable without a session. Everything else requires the cookie.
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/login",
  // Self-service password reset + invite set-password (issue #985). Session-free by
  // nature (the user has no live session); the Node handlers do the real work
  // (token hash lookup + expiry/single-use), and refuse an invalid/expired token
  // with a generic message — no oracle, mirroring /share/* and the calendar feed.
  "/forgot-password",
  "/set-password",
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
  // PWA share target (issue #1423). Session-free at the COARSE layer only: the OS
  // share sheet sends a multipart POST, and middleware's anonymous branch answers
  // with NextResponse.redirect — a method-PRESERVING 307, which would re-POST the
  // shared file at /login (a page route that can't accept it). So the handler
  // (app/share-target/route.ts) takes the decision instead: it calls
  // getCurrentSession() itself — the authoritative check, exactly as this module's
  // header describes — and answers an anonymous share with a 303 (see-other, so the
  // browser follows with GET) to /login, storing NOTHING. Nothing is served here
  // without a session; the allowlist only buys the handler the right status code.
  "/share-target",
  // Remote document upload + its profile resolver (issues #1734/#1735). Bearer-token
  // authenticated, never cookie authenticated: a CLI on another machine has no session.
  // Listed for exactly the /share-target reason — middleware's anonymous branch answers
  // with a method-PRESERVING 307, which would re-POST a multipart upload at /login (a
  // page route that cannot accept it) instead of returning the 401 the caller can act
  // on. The allowlist is COARSE and buys these handlers nothing but the right to answer
  // for themselves: each calls authenticateApiToken() — which resolves the token, checks
  // it is not revoked, and demands the `upload:documents` capability — and then composes
  // its own explicit write gate before touching a profile. That call IS the gate.
  "/api/documents",
  "/api/documents/profiles",
  // The allos-side portal/account vocabulary a tool ingests at `init` (#1759). Same
  // family, same token, same scope, same reason for being listed as the two above.
  "/api/documents/portals",
  // The acquirer's end-of-run sync report (#1739). Same token, same scope, same reason
  // for being listed: a bearer POST from a tool on the user's own machine, which has no
  // cookie, and which the coarse middleware check would answer with a 307 at /login.
  "/api/documents/sync-report",
]);

export function isPublicPath(pathname: string): boolean {
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
