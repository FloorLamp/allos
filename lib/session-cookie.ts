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

/**
 * The `__Host-` name a cookie takes at a given Secure-ness.
 *
 * The constants below are this applied to THIS process's NODE_ENV, which is the
 * right answer for every caller that IS the server — middleware and the auth
 * layer both are. It is the wrong answer for a caller that mints a cookie for a
 * server it is not running inside: the e2e seed (e2e/seed/session.ts) writes a
 * storageState for `next start` workers that are always production while the
 * seed process itself is not, so it must ask for `true` explicitly rather than
 * read `SESSION_COOKIE`. Getting that backwards is silent — the browser stores a
 * perfectly valid cookie under a name the server never reads, and every request
 * is simply anonymous.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-ht_session" : "ht_session";
}

/** As `sessionCookieName`, for the slide mark. */
export function slideMarkCookieName(secure: boolean): string {
  return secure ? "__Host-ht_slid" : "ht_slid";
}

export const SESSION_COOKIE = sessionCookieName(SESSION_COOKIE_SECURE);

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

// ── THE SLIDE MARK (issue #2058) ─────────────────────────────────────────────
//
// The session's 30 days are sliding on BOTH sides — the DB's `expires_at`
// (SESSION_TOUCH in lib/auth.ts, every request) and the browser cookie's Max-Age
// (middleware). Since #2027 the cookie half only slides on GET/HEAD, because a
// middleware Set-Cookie during a Server Action POST marks the whole action
// response "revalidated" (see middleware.ts / middleware-sliding-cookie.test.ts).
//
// A session used ONLY through action POSTs — a tab left open on one page, logging
// doses or workouts through forms, never navigating — therefore kept its DB row
// alive out toward the 90-day ceiling while its cookie quietly aged out ~30 days
// after the last navigation. The user is signed out with no warning while the
// server still considers the session live.
//
// The fix is the cheap half of the issue's prescription: re-issue on a POST, but
// RARELY. The server can't read a cookie's remaining Max-Age, so the elapsed time
// since the last slide is carried by a second cookie whose own, shorter Max-Age
// IS the clock — while the browser still sends the mark, the session cookie was
// re-issued within the mark's TTL; once the mark is gone, the session cookie has
// less than (30 − 7) days left and any request, POST included, re-issues both.
//
// The mark holds no secret (a constant), so it is never a second copy of the
// token; it exists only to be present or absent.
export const SESSION_SLIDE_MARK_COOKIE = slideMarkCookieName(
  SESSION_COOKIE_SECURE
);
export const SESSION_SLIDE_MARK_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const SESSION_SLIDE_MARK_VALUE = "1";

// The whole policy, pure: when does a request re-issue the session cookie?
//
// Navigations always do (they cost nothing — no action response to mark
// revalidated). Anything else does only once the mark has expired, which bounds
// how far the cookie's Max-Age can lag the DB's expires_at at ONE mark TTL: a
// pure-POST session is signed out at most 7 days before its server-side session
// would have died, instead of up to 60. The price is at most one Set-Cookie per
// mark TTL on an action response, i.e. rare rather than every POST — and a
// session that ever navigates never reaches it at all.
export function shouldSlideSessionCookie(
  method: string,
  hasSlideMark: boolean
): boolean {
  return method === "GET" || method === "HEAD" || !hasSlideMark;
}
