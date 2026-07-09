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
