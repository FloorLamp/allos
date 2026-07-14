// Global security response headers (issue #21). Applied to every route by the
// `headers()` hook below. Route handlers (API, .ics feed, SSE, icons) get the
// same set — these are all response headers and none constrain a JSON/stream/
// binary body.
//
// The /share/* responses layer STRICTER values on top in middleware.ts
// (withShareHeaders: Referrer-Policy: no-referrer, plus Cache-Control/X-Robots-
// Tag) — middleware runs per-request and its `res.headers.set(...)` overrides
// these config defaults for that route, which is verified by the e2e spec.
// withShareHeaders does NOT touch the CSP, so the enforced policy below rides
// along on share pages unchanged (it never weakens or double-sets their headers).
//
// CSP graduation (issue #595, executing the #21 rollout plan). Step 2 is now
// DONE: the non-script directives are ENFORCED in the real Content-Security-
// Policy header — `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`,
// `form-action 'self'`, `img-src 'self' data: blob:`, `connect-src 'self'`,
// alongside the always-safe `frame-ancestors 'none'` (clickjacking defense that
// mirrors X-Frame-Options: DENY). These were audited quiet against every app
// surface before flipping: same-origin avatar/profile-photo images and data:
// icons (img-src), blob: crop-preview URLs (img-src blob:), same-origin SSE for
// the AI-log stream (connect-src), the same-origin PDF <iframe> document preview
// (frame-src falls back to default-src 'self' — NOT constrained by object-src,
// which only governs <object>/<embed>/<applet>, none of which exist in the tree),
// and external maps links which are top-level <a> navigations, not subresources
// any directive governs. No form posts to external hosts.
//
// NOTE: `script-src`/`style-src` ARE declared in the enforced header, but only
// because `default-src 'self'` would otherwise become their fallback and block
// Next's inline App Router bootstrap <script> and the theme-boot inline script
// (app/layout.tsx) plus Tailwind's inline styles. Their enforced value keeps
// `'unsafe-inline'` — i.e. exactly today's permissiveness, NOT a tightening.
// Step 3 (the follow-up) removes `'unsafe-inline'` via a per-request nonce
// threaded through the framework (Next supports this via middleware + the `nonce`
// request header); `style-src 'unsafe-inline'` may have to stay for Tailwind and
// that call gets made explicitly then. The strict, nonce-based script/style
// policy will be trialed in the Content-Security-Policy-Report-Only header first
// (its purpose from here on) before it graduates into the enforced header.

// ENFORCED policy (real Content-Security-Policy header). See the note above on
// why script-src/style-src appear here with 'unsafe-inline' rather than being
// left to the default-src fallback.
const ENFORCED_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

// REPORT-ONLY policy (Content-Security-Policy-Report-Only header). Now scoped to
// the directives still awaiting the nonce work (step 3): it is the test bed where
// a stricter, nonce-based `script-src`/`style-src` (dropping 'unsafe-inline') gets
// trialed in the field before it graduates into the enforced header above. Until
// that trial begins it mirrors the enforced permissive value, so it reports
// nothing today — that's intentional; it holds the place for the tightening.
const REPORT_ONLY_CSP = [
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

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
  // Enforced now (issue #595): the full non-script policy plus the always-safe
  // frame-ancestors clickjacking defense. script-src/style-src ride along with
  // 'unsafe-inline' only to keep default-src from blocking framework inline
  // script/style — the nonce tightening is trialed report-only below first.
  { key: "Content-Security-Policy", value: ENFORCED_CSP },
  { key: "Content-Security-Policy-Report-Only", value: REPORT_ONLY_CSP },
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
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // better-sqlite3 is a native module; keep it external to the server bundle.
  // Graduated out of `experimental` in Next 15 (was
  // experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["better-sqlite3"],
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
