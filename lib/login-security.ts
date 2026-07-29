// Pure login-hardening helpers: a same-origin redirect-target validator and a
// user-agent truncator. No DB, no network — unit-testable, and the login action
// wires them to real request data. (The failed-attempt throttle itself is
// DB-backed and lives in the login action, with its pure decision logic in
// lib/login-lockout.ts.)

import type { AppRoute } from "./hrefs";

// Validate a `?next=` redirect target down to a safe, same-origin relative path.
// Must be a non-empty path that starts with a single "/" (not "//", which the
// browser reads as a protocol-relative URL to another host) and carries no
// scheme (blocks "javascript:" and absolute "http://evil"). Anything else is
// rejected — the caller falls back to "/".
export function isSafeNextPath(next: unknown): next is string {
  if (typeof next !== "string" || next.length === 0) return false;
  if (next[0] !== "/") return false; // must be relative to our origin
  if (next[1] === "/" || next.startsWith("/\\")) return false; // protocol-relative
  if (/^\/[^/]*:/.test(next)) return false; // stray scheme-like segment
  if (/[\x00-\x1f]/.test(next)) return false; // control chars (incl. newlines)
  return true;
}

// Returns a validated internal redirect target as an `AppRoute` (the typed-routes
// alias) so it feeds `redirect()`/`<Link>` without a callsite cast. The value is
// a runtime-sanitized same-origin path (any deep link the user was headed to),
// which `isSafeNextPath` has already proven internal — typedRoutes can't see that
// proof, so the widening happens here, in the one place that owns the guarantee.
export function safeNextPath(
  next: unknown,
  fallback: AppRoute = "/"
): AppRoute {
  return isSafeNextPath(next) ? (next as AppRoute) : fallback;
}

// The honest sign-in outcome for a login that authenticates but can reach NO profile
// (issue #1434) — a member created before anyone granted it access. It used to mint a
// session, redirect, and then bounce back to an EMPTY sign-in form on every request,
// with no message and no signal to the admin. Lives here (a pure module) rather than
// in the "use server" action file, which may only export async functions, so specs and
// tests can assert the exact copy the form shows.
//
// NOT an enumeration surface: it is only ever reached AFTER the credentials — and any
// second factor — verified, so whoever sees it already holds the password.
export const NO_PROFILE_ACCESS =
  "Your login works, but it has no profile access yet — ask your admin to grant a profile.";

// Validate a `?u=` sign-in prefill (issue #1434). After completing an invite the
// person just proved possession of a token minted FOR that username, so the sign-in
// form can fill it in rather than making them recall a name the admin chose. Only
// the stored username shape is accepted (the same 3–32 letters/digits/dot/dash/
// underscore the family action enforces), so an arbitrary querystring can never be
// reflected into the page; anything else yields "" and the field starts empty.
// Prefilling is not an oracle: the value is echoed back unverified, so it says
// nothing about whether such a login exists.
export function safePrefillUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^[a-zA-Z0-9._-]{3,32}$/.test(value) ? value : "";
}

// Normalize a request User-Agent header for storage against a session, so the
// active-sessions view can show "which device" without letting a hostile client
// bloat the row. Trims, collapses whitespace, and caps the length; a missing or
// empty header becomes null (rendered as "Unknown device").
export function truncateUserAgent(ua: unknown, maxLen = 200): string | null {
  if (typeof ua !== "string") return null;
  const cleaned = ua.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
