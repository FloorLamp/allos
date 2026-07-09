// Pure login-hardening helpers: a same-origin redirect-target validator and a
// user-agent truncator. No DB, no network — unit-testable, and the login action
// wires them to real request data. (The failed-attempt throttle itself is
// DB-backed and lives in the login action, with its pure decision logic in
// lib/login-lockout.ts.)

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

export function safeNextPath(next: unknown, fallback = "/"): string {
  return isSafeNextPath(next) ? next : fallback;
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
