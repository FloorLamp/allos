# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**. Do **not** open a public
GitHub issue for a security bug — public issues are visible to everyone and can
expose users before a fix is available.

To report a vulnerability, use GitHub's private advisory workflow:

1. Go to the repository's **Security** tab.
2. Select **Advisories → Report a vulnerability**.

This opens a private channel visible only to the maintainers. Please include:

- a description of the issue and its potential impact,
- steps to reproduce (a proof of concept if possible),
- affected routes, versions, or configuration, and
- any suggested remediation.

We will acknowledge your report, keep you updated on our progress, and credit
you (if you wish) once a fix is released.

## Supported versions

Allos is developed as a rolling release. Security fixes are applied to the
`main` branch, and self-hosters should track `main` (or the latest published
container image) to receive them. Older commits and tags are not separately
patched.

## Scope

Because Allos stores personal health information (PHI), we are especially
interested in reports involving authentication/session handling, profile data
isolation (cross-profile data access), file upload/serving, and any path that
could leak stored medical data. Please never include real PHI in a report — use
synthetic or redacted data to demonstrate an issue.

## Hardening posture

### Response headers

Every response carries a baseline set of security headers, configured globally in
`next.config.js` (`headers()`) and applied to every route (pages and API/route
handlers alike):

- `Strict-Transport-Security: max-age=15552000; includeSubDomains` — 180-day
  HSTS. **No `preload`** on purpose: a self-hoster may run plain-HTTP internal
  subdomains, and the public preload list is an irreversible commitment we won't
  make on their behalf.
- `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`
  — clickjacking defense (the CSP directive covers CSP-aware browsers; the
  legacy header covers the rest).
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  — denies browser features the app never uses.

Public share links (`/share/*`) layer **stricter** values on top in
`middleware.ts` (`withShareHeaders`): `Referrer-Policy: no-referrer`,
`Cache-Control: no-store, must-revalidate`, and `X-Robots-Tag: noindex, nofollow`
so a sensitive, unauthenticated passport is never cached or indexed. Middleware
runs per-request and its values override the global defaults for that route.

### Content-Security-Policy graduation plan

The full CSP ships as **report-only** (`Content-Security-Policy-Report-Only`) so
the policy can be observed in the field without breaking anything. Only
`frame-ancestors 'none'` is **enforced** today (via a separate real
`Content-Security-Policy` header), because it is safe to enforce immediately
alongside `X-Frame-Options`.

The report-only policy keeps `'unsafe-inline'` in `script-src`/`style-src`
because Next 14's App Router emits inline bootstrap/runtime scripts and Tailwind
emits inline styles; a nonce-based strict CSP requires threading a per-request
nonce through the framework and is a deliberate follow-up. The graduation path:

1. Watch report-only violations until the policy is clean in practice.
2. Move the non-script directives (`default-src`, `object-src`, `base-uri`,
   `form-action`, `connect-src`, `img-src`) from report-only into the enforced
   header.
3. Introduce a per-request nonce, drop `'unsafe-inline'`, and enforce
   `script-src`/`style-src` last.

### Session cookie

The session cookie uses the `__Host-` name prefix in production
(`__Host-ht_session`), which a browser only accepts when the cookie is Secure,
`Path=/`, and has no `Domain` — hardening it against subdomain cookie injection.
Over plain-HTTP dev the plain name (`ht_session`) is used, since the prefix
requires Secure. The cookie stays `HttpOnly` + `SameSite=Lax`.
