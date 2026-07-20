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
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/share/:path*", headers: SHARE_HEADERS },
    ];
  },
  // Route-merge redirects (#1042 migration mechanics): a removed route gets a
  // PERMANENT redirect to its merged page, anchor included — old Telegram
  // messages, bookmarks, and precached service-worker entries carry absolute
  // URLs forever, so removal without a redirect strands them (the pre-#285
  // consolidations dropped routes outright; the #1042 merges do not). The
  // destination must resolve to a real page — guarded by
  // lib/__tests__/nav-routes.test.ts.
  async redirects() {
    return [
      // Phase 3: the Emergency Card folded into the Passport page as its
      // #emergency section. The redirect target still requires a session
      // (requireSession in the (app) layout), so an anonymous hit lands on
      // /login exactly as the old route did.
      {
        source: "/emergency",
        destination: "/profile#emergency",
        permanent: true,
      },
      // Phase 5: the three read-heavy result index pages folded into /results as
      // anchored sections. EXACT-path sources only (path-to-regexp without a
      // wildcard matches nothing deeper), which matters for /biomarkers: the
      // per-biomarker detail page /biomarkers/view SURVIVES at its route and must
      // never be caught by the index redirect. Query strings (e.g. the palette's
      // ?new=1&name=… prefill, the ?q= filter) pass through to the destination.
      {
        source: "/biomarkers",
        destination: "/results#biomarkers",
        permanent: true,
      },
      {
        source: "/imaging",
        destination: "/results#imaging",
        permanent: true,
      },
      {
        source: "/genomics",
        destination: "/results#genomics",
        permanent: true,
      },
    ];
  },
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
      // reject the large uploads `uploadMedicalDocument` explicitly permits before
      // the action runs. Set to 65MB (64MB + 1MB): the largest permitted upload is a
      // 64MB deterministic health record (`MAX_HEALTH_BYTES`, lib/upload-gate.ts,
      // re-exported from lib/medical-pipeline.ts), whose multipart body is the file
      // bytes PLUS boundary/field overhead. The 1MB of headroom keeps the app's own
      // per-path gates (32MB AI / 64MB health) authoritative, so an over-size file
      // hits its friendly `insertFailedDoc` audit path instead of an opaque framework
      // rejection. This lockstep is guarded by
      // lib/__tests__/upload-size-lockstep.test.ts (issue #696) — bump both together.
      bodySizeLimit: "65mb",
    },
    // SECOND, EARLIER body cap that `bodySizeLimit` above does NOT cover. Next 16
    // clones the request body for middleware (this app has a middleware.ts whose
    // matcher covers the upload route), and that clone is capped by
    // `proxyClientMaxBodySize` — default 10MB. Over the cap, Next does NOT reject:
    // it `console.warn`s and TRUNCATES the body to the first 10MB, then hands the
    // truncated stream to the Server Action. An over-10MB health-record upload
    // (e.g. a multi-document MyChart XDM) then arrives as a broken multipart whose
    // file field is cut off, so `uploadMedicalDocument` sees an empty File and
    // silently returns — an upload that "fails" with no error row and only a
    // buried framework warning. Keep it in lockstep with `bodySizeLimit` above (65MB)
    // so the app's own per-path gates (32MB AI / 64MB health, lib/upload-gate.ts)
    // stay the single authoritative limit. Guarded by
    // lib/__tests__/upload-size-lockstep.test.ts (issue #696).
    proxyClientMaxBodySize: "65mb",
  },
};

module.exports = nextConfig;
