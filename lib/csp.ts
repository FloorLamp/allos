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
  // Same-origin avatars/profile photos + data: icons + blob: crop previews.
  "img-src 'self' data: blob:",
  // Same-origin SSE (AI-log stream) etc.
  "connect-src 'self'",
  // Tailwind + Next inline styles; kept 'unsafe-inline' by design (see header).
  "style-src 'self' 'unsafe-inline'",
];

// THE ONE PATH THE APP FRAMES ITSELF (#3975).
//
// `/import/[id]` previews a stored PDF with `<iframe src="/medical/file/<id>">`
// (components/DocumentPreview.tsx). The blanket `frame-ancestors 'none'` this
// module shipped in #624 forbade that too — a spec-compliant browser must refuse
// — so the Document pane rendered the browser's own refusal page instead of the
// document, on every browser, everywhere, from #624 until now. Only PDFs were
// affected: images preview through `<img>`, which `img-src 'self'` admits.
//
// SCOPED TO THIS PREFIX, NOT RELAXED APP-WIDE, and the reason is the trade rather
// than the blast radius. App-wide `'self'` is what most apps run and would be
// defensible here; the owner ruled against it (2026-08-28, #3975) because this
// app serves PHI on every page and giving up clickjacking protection on all of
// them to fix one route is the wrong direction for the one that matters.
//
// WHAT A THIRD PARTY CAN DO AFTERWARDS: nothing it could not do before. `'self'`
// admits same-origin ancestors ONLY, so no other origin may frame this route —
// or any other route, which all keep `'none'`. What changes is that allos may
// frame its own stored file, which is the thing it was already trying to do.
const SELF_FRAMED_PREFIX = "/medical/file/";

/**
 * Does this path serve a document the app frames inside its own pages?
 *
 * The trailing slash is load-bearing: it matches the `[id]` route's children and
 * nothing that merely starts with the same letters (`/medical/files/1`).
 */
export function isSelfFramedPath(pathname: string): boolean {
  return pathname.startsWith(SELF_FRAMED_PREFIX);
}

/**
 * Build the full Content-Security-Policy header value.
 *
 * @param nonce       Per-request nonce (from `generateNonce()`), used only in the
 *                    production script-src.
 * @param isDev       True under `next dev` — relaxes script-src to allow HMR's
 *                    eval + un-nonced inline scripts, and omits the nonce token.
 * @param selfFramed  True for the one route the app frames itself
 *                    (`isSelfFramedPath`) — the ONLY thing it changes is
 *                    frame-ancestors, from `'none'` to `'self'`.
 */
export function buildCsp(
  nonce: string,
  isDev: boolean,
  selfFramed = false
): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}'`;
  // Clickjacking defense. middleware.ts stamps the matching X-Frame-Options
  // (DENY / SAMEORIGIN) from the same boolean: where both headers are present a
  // browser enforces frame-ancestors and ignores XFO, but a DENY left standing
  // beside a `'self'` is a trap for the next reader, so the mirror moves with it.
  const frameAncestors = selfFramed
    ? "frame-ancestors 'self'"
    : "frame-ancestors 'none'";
  return [...STATIC_DIRECTIVES, frameAncestors, scriptSrc].join("; ");
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
