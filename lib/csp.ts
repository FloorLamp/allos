// Shared CSP builder for middleware.ts. Keep this dependency-free for the Edge
// runtime. SECURITY.md describes the response policy and its scope.
//
// Production permits same-origin scripts and nonced inline bootstrap scripts.
// Keep the request CSP and x-nonce aligned so Next and the theme bootstrap use
// the same nonce. Styles allow inline declarations for the rendering pipeline;
// development also permits inline scripts and eval for hot reload.

const STATIC_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  // Same-origin avatars/profile photos + data: icons + blob: crop previews.
  "img-src 'self' data: blob:",
  // Same-origin SSE (AI-log stream) etc.
  "connect-src 'self'",
  // Inline styles are required by the current rendering pipeline.
  "style-src 'self' 'unsafe-inline'",
];

// Stored PDFs are framed by DocumentPreview. Only this route permits same-origin
// ancestors; middleware derives X-Frame-Options from the same path decision.
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
