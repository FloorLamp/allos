// Session cookie NAME — the single source of truth, imported by both the Edge
// middleware (middleware.ts) and the Node auth layer (lib/auth.ts). This module
// MUST stay dependency-free (no better-sqlite3, no `next/headers`, nothing that
// can't load on the Edge runtime) so middleware can import it.
//
// __Host- prefix (issue #21). A cookie whose name starts with `__Host-` is only
// accepted by browsers when it is Secure, has Path=/, and carries NO Domain
// attribute — the browser rejects it otherwise. That makes the session cookie
// immune to being overwritten/injected by a sibling subdomain or a network MITM
// on a non-secure origin. We can only use the prefix when the cookie is actually
// Secure, which is production-only (dev/HTTP self-hosts keep working with the
// plain name). Both middleware and auth.ts compute `secure` from the same
// NODE_ENV === "production" check, so the name and the Secure flag never drift.
//
// Migration note: existing sessions keep sending the old `ht_session` cookie.
// After this ships in production the server only reads `__Host-ht_session`, so
// those users are silently unauthenticated once and simply re-login; the stale
// cookie is ignored (and expires on its own). No server-side session rows are
// invalidated.
export const SESSION_COOKIE_SECURE = process.env.NODE_ENV === "production";

export const SESSION_COOKIE = SESSION_COOKIE_SECURE
  ? "__Host-ht_session"
  : "ht_session";

// Second-factor challenge cookie (issue #23). Between a correct password and a
// correct TOTP code the login is NOT authenticated — no session exists. This
// short-lived cookie carries only the random challenge token (the DB row it maps
// to holds the login id + expiry); it is never a session. Same __Host- hardening
// and Secure-gated naming as the session cookie so the two never drift on the
// Secure attribute.
export const TWO_FACTOR_COOKIE = SESSION_COOKIE_SECURE
  ? "__Host-ht_2fa"
  : "ht_2fa";

// Session TTL — 30 days, the sliding-refresh window. Kept here (dependency-free)
// alongside the cookie name so the browser max-age and the DB expires_at can't
// drift on the number, and so the cookie attributes are unit-testable without
// pulling in the SQLite-backed auth layer (issue #676).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_TTL_SEC = SESSION_TTL_MS / 1000;

// Cookie attributes shared by the login action and the middleware refresh, so
// the sliding re-set can't drift from the original. `secure` only in prod so the
// cookie still works over plain HTTP in local dev — and it's the SAME flag that
// picks the `__Host-` cookie name (SESSION_COOKIE_SECURE above), so the name
// never disagrees with the Secure attribute the prefix requires. The `__Host-`
// prefix additionally mandates Path=/ and no Domain, both satisfied here. Lives
// in this Edge-safe module (no next/headers, no db) so the Node auth layer
// re-exports it and a pure test can pin the attributes (issue #676).
export function sessionCookieOptions(maxAgeSec: number = SESSION_TTL_SEC) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: maxAgeSec,
  };
}
