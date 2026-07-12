// Global security response headers (issue #21). Applied to every route by the
// `headers()` hook below. Route handlers (API, .ics feed, SSE, icons) get the
// same set — these are all response headers and none constrain a JSON/stream/
// binary body; the only body-shaping header, the CSP, is report-only (except the
// always-safe `frame-ancestors`), so nothing can be blocked in this rollout.
//
// The /share/* responses layer STRICTER values on top in middleware.ts
// (withShareHeaders: Referrer-Policy: no-referrer, plus Cache-Control/X-Robots-
// Tag) — middleware runs per-request and its `res.headers.set(...)` overrides
// these config defaults for that route, which is verified by the e2e spec.
//
// CSP graduation plan. We ship the FULL policy as report-only
// (Content-Security-Policy-Report-Only) so it can be observed in the field
// without breaking anything, and enforce ONLY `frame-ancestors 'none'` today via
// a separate real Content-Security-Policy header — that directive is
// clickjacking defense equivalent to X-Frame-Options: DENY and is safe to turn on
// immediately. `script-src`/`style-src` keep `'unsafe-inline'` because Next's
// App Router emits inline bootstrap/runtime <script> and Tailwind emits inline
// styles; a nonce-based strict CSP requires threading a per-request nonce through
// the framework and is deliberately left as a follow-up. Once the report-only
// policy shows no legitimate violations, graduate directives out of report-only
// into the enforced header one at a time (start with the non-script directives —
// object-src/base-uri/form-action/default-src — then tackle script/style behind
// nonces last).
const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
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
  // Enforced now: clickjacking defense (mirrors X-Frame-Options: DENY for CSP-
  // aware browsers). Everything else in the policy is report-only below.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
      // reject the 1–32MB uploads `uploadMedicalDocument` explicitly permits before
      // the action runs. Set to 33MB (not 32MB) on purpose: the multipart body is
      // the file bytes PLUS boundary/field overhead, so a file at the action's 32MB
      // `MAX_BYTES` (lib/medical-pipeline.ts) produces a body just over 32MB.
      // The 1MB of headroom keeps the action's own 32MB gate authoritative, so an
      // over-size file hits its friendly `insertFailedDoc` audit path instead of an
      // opaque framework rejection.
      bodySizeLimit: "33mb",
    },
  },
};

module.exports = nextConfig;
