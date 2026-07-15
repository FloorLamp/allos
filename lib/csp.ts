// Content-Security-Policy — the SINGLE source of truth for the policy string
// (issue #595, step 3). This module is dependency-free and Edge-safe (no fs, no
// better-sqlite3, no `next/headers`) so the Edge middleware can import it, the
// same discipline as lib/session-cookie.ts. The CSP is now built and emitted
// EXCLUSIVELY by middleware.ts (per-request, because of the nonce) — next.config
// no longer declares a Content-Security-Policy header, so there is exactly one
// copy of the policy and it cannot drift between two files.
//
// Rollout history: #21 shipped the policy report-only, #624 enforced the
// non-script directives (default-src/base-uri/object-src/form-action/img-src/
// connect-src + the always-safe frame-ancestors) while script-src/style-src kept
// 'unsafe-inline' as a placeholder. This step removes 'unsafe-inline' from
// script-src via a per-request nonce.
//
// script-src — the hardening. In production the policy is `'self'
// 'nonce-<value>'`, with NO 'unsafe-inline'. Rationale for each choice:
//   * DROP 'unsafe-inline': a browser that understands nonces IGNORES a
//     coexisting 'unsafe-inline', so keeping it would only re-open inline
//     execution for legacy browsers that don't grok nonces — i.e. it would give
//     the weakest clients zero protection while adding nothing for everyone else.
//     Dropping it is the whole point of step 3, so we drop it cleanly.
//   * KEEP bare 'self' (do NOT switch to 'strict-dynamic'): every script this app
//     serves is same-origin — Next's App Router bootstrap plus its chunk
//     `<script src="/_next/...">` tags — so 'self' already admits all of them,
//     and the nonce admits the two inline bootstrap scripts (Next's own inline
//     bootstrap, which Next stamps with the nonce it reads from the request-header
//     CSP, and app/layout.tsx's theme-boot script, which reads the nonce from the
//     x-nonce header). 'strict-dynamic' would make 'self' be IGNORED and force
//     EVERY script tag to carry a propagated nonce/hash, which is strictly more
//     fragile for a fully same-origin bundle and buys nothing here. So we keep
//     'self' + nonce and skip 'strict-dynamic'.
//
// style-src — KEEPS 'unsafe-inline'. Tailwind's utility layer and Next both emit
// inline <style> without a nonce hook, and there is no per-style nonce mechanism
// in play, so style-src stays 'unsafe-inline' by deliberate decision (documented
// per the issue). Inline STYLE is a far weaker vector than inline SCRIPT.
//
// Dev — `next dev`'s React Fast Refresh and error overlay need 'unsafe-eval' and
// emit un-nonced inline scripts, so in development script-src is `'self'
// 'unsafe-inline' 'unsafe-eval'` with NO nonce token (a nonce token would make
// the browser ignore 'unsafe-inline' and break HMR). e2e runs `next dev` locally
// and `next start` in CI, so both branches must work.

const STATIC_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  // Clickjacking defense, mirrors X-Frame-Options: DENY.
  "frame-ancestors 'none'",
  // Same-origin avatars/profile photos + data: icons + blob: crop previews.
  "img-src 'self' data: blob:",
  // Same-origin SSE (AI-log stream) etc.
  "connect-src 'self'",
  // Tailwind + Next inline styles; kept 'unsafe-inline' by design (see header).
  "style-src 'self' 'unsafe-inline'",
];

/**
 * Build the full Content-Security-Policy header value.
 *
 * @param nonce   Per-request nonce (from `generateNonce()`), used only in the
 *                production script-src.
 * @param isDev   True under `next dev` — relaxes script-src to allow HMR's
 *                eval + un-nonced inline scripts, and omits the nonce token.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}'`;
  return [...STATIC_DIRECTIVES, scriptSrc].join("; ");
}

/**
 * Generate a per-request nonce: 16 random bytes, base64-encoded. Uses Web Crypto
 * + btoa so it runs unchanged on the Edge runtime (Buffer is not available there).
 */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
