// Global security response headers (issue #21). Applied to every route by the
// `headers()` hook below. Route handlers (API, .ics feed, SSE, icons) get the
// same set — these are all response headers and none constrain a JSON/stream/
// binary body.
//
// The /share/* responses layer STRICTER values on top in middleware.ts
// (withShareHeaders: Referrer-Policy: no-referrer, plus Cache-Control/X-Robots-
// Tag) — middleware runs per-request and its `res.headers.set(...)` overrides
// these config defaults for that route, which is verified by the e2e spec.
//
// CSP lives in middleware, NOT here (issue #595, step 3 — final). The full
// Content-Security-Policy is now built and set per-request by middleware.ts (from
// the single-source-of-truth builder lib/csp.ts), because its script-src carries
// a per-request nonce that a static config header can't express. So this config
// declares NO Content-Security-Policy / -Report-Only header at all — moving it out
// keeps exactly ONE copy of the policy and removes the report-only test bed that
// #624 used to trial the nonce tightening (now graduated).
//
// Final policy shape (see lib/csp.ts for the full reasoning): the non-script
// directives are unchanged from #624 (default-src 'self', base-uri 'self',
// object-src 'none', form-action 'self', the always-safe frame-ancestors 'none',
// img-src 'self' data: blob:, connect-src 'self'); script-src drops 'unsafe-inline'
// for `'self' 'nonce-<value>'` (dev keeps 'unsafe-inline' + adds 'unsafe-eval' for
// HMR); style-src KEEPS 'unsafe-inline' by design (Tailwind + Next inline styles
// have no nonce hook). The theme-boot inline script (app/layout.tsx) and Next's
// own inline bootstrap both carry the nonce.

const SECURITY_HEADERS = [
  // HSTS: 180 days, includeSubDomains but NOT preload — a self-hoster may run
  // plain-HTTP internal subdomains, and `preload` (with the public preload list)
  // would be an irreversible commitment we can't make on their behalf.
  {
    key: "Strict-Transport-Security",
    value: "max-age=15552000; includeSubDomains",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // NOTE: Content-Security-Policy is intentionally NOT here — it is emitted
  // per-request by middleware.ts (nonce'd script-src). See the comment block above.
];

// Next applies its own document-cache header after middleware in development (and may
// do so in future production render paths), so /share hardening also lives at the final
// route-header boundary. Keep this in lockstep with middleware.withShareHeaders: these
// unauthenticated PHI-bearing responses must never be retained after revocation.
const SHARE_HEADERS = [
  { key: "Cache-Control", value: "no-store, must-revalidate" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16's dev server takes a per-project single-instance lock (.next/dev/lock),
  // so the e2e demo instance (#181) can no longer `next dev` from the same dir as
  // the main instance. An env-driven distDir gives the demo dev server its own
  // build dir (playwright.config.ts sets NEXT_DIST_DIR=.next-demo, dev only —
  // CI's two `next start` instances share the one .next build and take no lock).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The workstation's nginx virtual hosts proxy the development server on port
  // 3000. Allow those origins so Next's HMR WebSocket works through the proxy;
  // ordinary page requests already carry the same preserved Host header.
  allowedDevOrigins: ["allos.agent.wang.team", "allos.agent.nortonwang.com"],
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/share/:path*", headers: SHARE_HEADERS },
    ];
  },
  // NO `redirects()` table by design (#1635). The #1042/#1079 route merges used to
  // ship a permanent redirect per removed URL so old Telegram messages, bookmarks,
  // and precached service-worker entries kept resolving. That compatibility table was
  // removed by owner decision on 2026-07-29: a route that no longer exists now 404s,
  // and a future route merge does NOT get a redirect by default — shipping one is a
  // per-case decision, not a convention to restore by pattern-matching old commits.
  // (See AGENTS.md, "Routes and APIs".)
  // Native / heavy server-only packages kept OUT of the server bundle. better-sqlite3
  // is a native module; @napi-rs/canvas is a native rasterizer and tesseract.js loads
  // WASM + worker assets — all used only in the OCR reconciliation fallback
  // (lib/pdf-ocr), reached via dynamic import so they never touch a normal request.
  // Graduated out of `experimental` in Next 15 (was
  // experimental.serverComponentsExternalPackages).
  serverExternalPackages: [
    "better-sqlite3",
    "@napi-rs/canvas",
    "tesseract.js",
    "unpdf",
  ],
  // Statically typed links (issue #285): Next generates a `Route` type from the
  // real `app/` tree, so an invalid pathname in any `<Link href>` — or in any
  // href-carrying field typed `AppRoute` (see lib/hrefs.ts) — fails `tsc`, and
  // `npm run build` is the CI/deploy gate. Stable top-level config in Next 16
  // (was `experimental.typedRoutes`). This is what makes a dead route (a href to
  // a page.tsx that was removed in a consolidation) impossible by construction.
  typedRoutes: true,
  experimental: {
    // Tree-shake barrel imports: only the icon/chart pieces actually used are
    // pulled into each route's bundle (Next rewrites `import { X } from "pkg"`
    // to deep per-module imports), shrinking the client JS on analytics routes.
    optimizePackageImports: ["recharts", "@tabler/icons-react"],
    // Server Actions are stable (enabled by default) in Next 15, but the config
    // sub-object that tunes them still lives under `experimental`.
    serverActions: {
      // Server Action body cap. Next defaults this to 1MB, which would silently
      // reject the large uploads `uploadMedicalDocument` / the video-capture actions
      // explicitly permit before the action runs. Set to 101MB (100MB + 1MB): the
      // largest permitted upload is now a 100MB video clip (`MAX_VIDEO_BYTES`,
      // lib/video/policy.ts — the product-documented 60s/100MB cap, #1224), which sits
      // ABOVE the 64MB deterministic health record (`MAX_HEALTH_BYTES`,
      // lib/upload-gate.ts). This figure is a FLOOR derived from the largest permitted
      // upload, not a fixed ceiling — it tracks whichever app cap is biggest, plus the
      // multipart boundary/field overhead. The 1MB of headroom keeps the app's own
      // per-path gates (32MB AI / 64MB health / 100MB video) authoritative, so an
      // over-size file hits its friendly in-app reject path instead of an opaque
      // framework rejection. This lockstep is guarded by
      // lib/__tests__/upload-size-lockstep.test.ts (issues #696/#1364) — bump this,
      // proxyClientMaxBodySize, and the governing app cap together.
      bodySizeLimit: "101mb",
    },
    // SECOND, EARLIER body cap that `bodySizeLimit` above does NOT cover. Next 16
    // clones the request body for middleware (this app has a middleware.ts whose
    // matcher covers the upload route), and that clone is capped by
    // `proxyClientMaxBodySize` — default 10MB. Over the cap, Next does NOT reject:
    // it `console.warn`s and TRUNCATES the body to the first 10MB, then hands the
    // truncated stream to the Server Action. An over-10MB health-record upload
    // (e.g. a multi-document MyChart XDM) then arrives as a broken multipart whose
    // file field is cut off, so `uploadMedicalDocument` (or a video action) sees an
    // empty File and silently returns — an upload that "fails" with no error row and
    // only a buried framework warning. Keep it in lockstep with `bodySizeLimit` above
    // (101MB) so the app's own per-path gates (32MB AI / 64MB health / 100MB video,
    // lib/upload-gate.ts + lib/video/policy.ts) stay the single authoritative limit.
    // Guarded by lib/__tests__/upload-size-lockstep.test.ts (issues #696/#1364).
    proxyClientMaxBodySize: "101mb",
  },
};

module.exports = nextConfig;
