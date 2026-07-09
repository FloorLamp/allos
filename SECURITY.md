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

## Audit logging

Allos keeps a durable audit log (the `audit_events` table) recording **who did
what to whose data**, reviewable by an admin under **Settings → Audit**. Each
event stores a timestamp, the acting login (null for unauthenticated events such
as a failed login or a public share-link view), the active profile being acted
on, an action (e.g. `login.success`, `profile.switch`, `medical-file.view`,
`medical-document.upload`/`delete`, `share-link.create`/`revoke`/`view`,
`grant.update`, `login.create`/`delete`, `login.password-reset`), and short
coarse identifiers (record/file/login ids, a username, a grant diff).

What is recorded:

- **Authentication** — login success/failure/throttle (username only, **never**
  the password), logout, own-password change, and admin password resets.
- **PHI access** — medical-file downloads and public share-link views (by file
  or link **id**, never the file contents or the raw share token).
- **Admin/family changes** — profile create/delete, login create/delete, and
  grant-matrix changes.

The `detail` and `target` fields hold **identifiers only — never medical
content**. Records are retained **90 days** by default and pruned by the hourly
maintenance tick. The log spans every profile, so the viewer is **admin-only**;
login/profile ids are kept even after the referent is deleted (no foreign key),
so the trail survives account deletion. A `grant.update` event's `detail` records
the profile-id diff **including the access level** (e.g. `+2:read`, `~3:write`,
`-4`), so a change from read-only to read/write is itself auditable.

## Access control

Access is enforced on the **server**, never by the UI. Two independent checks
gate every request:

- **Profile isolation.** Every profile-owned table carries a `profile_id`, and
  every query filtering it is scoped to the acting profile — a member only ever
  sees the profiles granted to them (admins see all). A pure source-scanning test
  fails the build if an owned-table query omits `profile_id`.
- **Grant level (read vs write).** Each `login_profiles` grant carries an
  `access` level — `write` (read + edit — the default and historical behavior) or
  `read` (view-only). A member acting on a read-only-granted profile may browse
  everything but **cannot mutate**: every mutating Server Action calls
  `requireWriteAccess()` (in `lib/auth.ts`), which resolves the session and
  redirects a read-only grant before any write runs. Admins bypass grants and are
  always read/write. Uploads and AI extraction are writes (blocked); creating a
  share link or an outbound calendar/ingest token is a write (it mints new access,
  so it is blocked); reads, exports, and prints are allowed. A source-scanning
  test (`lib/__tests__/actions-write-access.test.ts`) fails the build if a
  mutating action forgets the guard — the check can't silently regress as new
  actions are added. Hidden edit affordances in the UI are a convenience only; the
  server guard is the authority.

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

### Upload content validation

Uploaded medical files are validated by their **magic bytes**, not the
client-declared `file.type` (`lib/file-sniff.ts`). On upload the server sniffs the
content, stores a byte-derived `mime_type`, and rejects a file whose contents
contradict its name/extension (a `.pdf` that isn't a PDF); text formats with no
reliable magic (CSV/plain text) fall back to an attachment-only type. The
file-serve route then echoes that trusted, byte-derived type as the Content-Type
and only renders a small allowlist inline (alongside `X-Content-Type-Options:
nosniff`), so a mislabeled upload can't be served as an inline, executable type.
