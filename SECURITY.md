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
`grant.update`, `login.create`/`delete`, `login.password-reset`,
`login.2fa-enable`/`2fa-disable`/`2fa-failure`/`2fa-recovery-used`/`2fa-bypass`),
and short coarse identifiers (record/file/login ids, a username, a grant diff).

What is recorded:

- **Authentication** — login success/failure/throttle (username only, **never**
  the password), logout, own-password change, and admin password resets.
- **Two-factor (2FA)** — enrolling/disabling TOTP, a failed second-factor code at
  login (username only, **never** the code), a one-time recovery code being
  redeemed, and any `ALLOS_DISABLE_2FA` bootstrap-recovery bypass.
- **PHI access** — medical-file downloads and public share-link views (by file
  or link **id**, never the file contents or the raw share token).
- **Admin/family changes** — profile create/delete, login create/delete, and
  grant-matrix changes.

The `detail` and `target` fields hold **identifiers only — never medical
content**. Records are retained **24 months** by default (admin-configurable —
`DEFAULT_AUDIT_RETENTION_MONTHS` in `lib/retention.ts`) and pruned by the hourly
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
- `X-Frame-Options: DENY` — clickjacking defense for legacy browsers; CSP-aware
  browsers get the same guarantee from the enforced CSP's
  `frame-ancestors 'none'` directive (see the next section — the CSP itself is
  emitted per-request by `middleware.ts`, not by `next.config.js`, so the policy
  has exactly one source).
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  — denies browser features the app never uses.

Public share links (`/share/*`) layer **stricter** values on top in
`middleware.ts` (`withShareHeaders`): `Referrer-Policy: no-referrer`,
`Cache-Control: no-store, must-revalidate`, and `X-Robots-Tag: noindex, nofollow`
so a sensitive, unauthenticated passport is never cached or indexed. Middleware
runs per-request and its values override the global defaults for that route.

### Content-Security-Policy (enforced, nonce-based)

The full CSP is **enforced** — there is no report-only header anymore. (Rollout
history: #21 shipped the policy report-only, #624 enforced the non-script
directives, and #595 completed the graduation to the nonce-based policy below.)

The policy has a **single source**: `lib/csp.ts` builds the header string, and
`middleware.ts` generates a fresh per-request nonce and stamps the
`Content-Security-Policy` header on every response — `next.config.js`
deliberately declares no CSP header at all, so the policy cannot drift between
two files.

Enforced directives in production:

- `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`,
  `form-action 'self'`
- `frame-ancestors 'none'` — clickjacking defense, mirroring
  `X-Frame-Options: DENY`
- `img-src 'self' data: blob:` — same-origin images plus data-URI icons and
  blob: crop previews
- `connect-src 'self'` — same-origin fetch/SSE only
- `script-src 'self' 'nonce-<per-request>'` — **no `'unsafe-inline'`**. The
  nonce admits the two inline bootstrap scripts (Next's own, which Next stamps
  from the request-header CSP, and the theme-boot script, which reads the
  `x-nonce` request header); every other script is a same-origin chunk covered
  by `'self'`. `'strict-dynamic'` is deliberately not used — every script this
  app serves is same-origin, so `'self'` + nonce is both sufficient and less
  fragile.
- `style-src 'self' 'unsafe-inline'` — the **one deliberate residual**:
  Tailwind's utility layer and Next both emit inline `<style>` with no per-style
  nonce hook, so inline _style_ (a far weaker vector than inline script) is
  accepted as a decided, documented exception rather than an oversight.

In development (`next dev` only), `script-src` relaxes to
`'self' 'unsafe-inline' 'unsafe-eval'` with no nonce token, because React Fast
Refresh and the error overlay require it; production builds never carry this
relaxation.

### Session cookie

The session cookie uses the `__Host-` name prefix in production
(`__Host-ht_session`), which a browser only accepts when the cookie is Secure,
`Path=/`, and has no `Domain` — hardening it against subdomain cookie injection.
Over plain-HTTP dev the plain name (`ht_session`) is used, since the prefix
requires Secure. The cookie stays `HttpOnly` + `SameSite=Lax`.

### Two-factor authentication (TOTP)

Each login may optionally enable **TOTP two-factor authentication** (RFC 6238:
30-second step, 6 digits, SHA-1) under **Settings → Preferences**. Enrollment
generates a secret shown as an `otpauth://` URI + manual base32 key; the login
must verify one code to activate, at which point **8 one-time recovery codes** are
shown **once**. 2FA is strongly recommended for admins.

- **Login flow.** When a password verifies for a 2FA-enabled login, **no session
  is created**. Instead a short-lived (5-minute) server-side _challenge_ row is
  written and its random token set as a separate, `__Host-`-hardened cookie — this
  is deliberately **not** a half-authenticated session. The second-factor step
  reads that cookie, verifies a TOTP (or a recovery code) — **rate-limited through
  the same lockout machinery as passwords** — and only then mints the real session
  and deletes the challenge.
- **Replay guard.** The last accepted TOTP step is stored per login; a code (or an
  older code still inside the ±1 verification window) cannot be reused once spent.
- **Storage.** The TOTP secret lives on the `logins` row. Recovery codes are stored
  only as their **SHA-256** (they are high-entropy random tokens, like session /
  share-link tokens, so a fast hash is appropriate — scrypt buys nothing for
  non-guessable secrets) and each is single-use.
- **Disabling** 2FA requires the current password **and** a valid code, so a
  walked-up open session alone can't strip the second factor off.
- **Bootstrap recovery.** If an admin loses their authenticator (and their recovery
  codes), the operator can set the env var **`ALLOS_DISABLE_2FA=<username>`**
  (comma-separated for several). At the next login that username's second-factor
  step is **skipped**; the bypass is logged loudly and written to the audit log
  (`login.2fa-bypass`). Remove the env var and re-enroll once access is restored.
  This is the documented escape hatch that prevents a permanent lock-out.

### Absolute session lifetime

Sessions use a **30-day sliding** expiry (each use re-extends it), so an active
session never expired on its own. On top of that there is now a hard **90-day
absolute ceiling** measured from `created_at`: regardless of how recently a session
was used, once it is 90 days old it stops resolving (enforced in the session lookup
and the purge) and the user must re-authenticate (password + 2FA). This bounds the
lifetime of a stolen-but-active session cookie.

### Password strength

Passwords must be at least **10 characters** and use at least **two character
classes** (lower / upper / digit / symbol), and may not contain the username. The
check (`lib/password-strength.ts`) is pure, offline, and dependency-free (no
`zxcvbn`, no network egress — suitable for an air-gapped self-host), and is applied
everywhere a password is set: admin create/reset and self-service change.

### Deferred: step-up re-auth for admin family actions

A **step-up re-auth** (a fresh 2FA code) on sensitive Family admin actions — grant
changes, login create/delete, password resets — is **not yet implemented**. Those
actions are already gated by `requireAdmin()` and, for a 2FA-enabled admin, sit
behind the full second-factor login. Threading a per-action fresh-code challenge
through the Family UI is tracked as a follow-up; see the PR for issue #23.

### Upload content validation

Uploaded medical files are validated by their **magic bytes**, not the
client-declared `file.type` (`lib/file-sniff.ts`). On upload the server sniffs the
content, stores a byte-derived `mime_type`, and rejects a file whose contents
contradict its name/extension (a `.pdf` that isn't a PDF); text formats with no
reliable magic (CSV/plain text) fall back to an attachment-only type. The
file-serve route then echoes that trusted, byte-derived type as the Content-Type
and only renders a small allowlist inline (alongside `X-Content-Type-Options:
nosniff`), so a mislabeled upload can't be served as an inline, executable type.
