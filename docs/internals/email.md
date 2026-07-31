# Outbound email — SMTP foundation + login-lifecycle flows

Status: **shipped** (phase 1 — SMTP config + invite-on-create + self-service
reset; issue #985). The **notification email channel is phase 2** (not built).

The internals + load-bearing invariants for outbound email. User-facing setup
lives in the README "Email" section; this is the design record.

## Scope

Phase 1 is **auth email only** — invite links and password-reset links. These
carry **no PHI** (they name the app and the action, nothing about anyone's
health data), which is why the main use case sidesteps email's leakiest-channel
problem entirely. A fourth `NotificationChannel` (per-profile address, kind
gating) is deliberately out of scope and gets its own issue.

## The pieces

- **`lib/email.ts` — the one sender chokepoint.** The SOLE importer of
  `nodemailer` (mirroring `lib/notifications/telegram.ts`), enforced by the
  source-scan test `lib/__tests__/email-chokepoint.test.ts`. It owns TLS
  enforcement (port 465 implicit, everything else STARTTLS via `requireTLS`),
  the "not configured ⇒ throw" gate, plaintext-first bodies (no attachments,
  ever), and the deterministic **test capture** (`EMAIL_TEST_CAPTURE=<file>`
  appends each send as JSON via nodemailer's `jsonTransport` — read at send time
  so tests/e2e can set it after import).
- **`lib/settings/email.ts` — global SMTP config.** Stored in the `settings` kv
  table (one relay serves the instance, like the Telegram bot token). The
  password is **write-only** in the UI (blank submit keeps it; a "remove"
  checkbox clears it — the AI-key posture). Env-seeded on first boot by
  `seedSmtpFromEnv` in `lib/migrations/boot-tasks.ts` (the
  `seedTimezoneFromEnv`/#875 pattern; keys inlined to keep boot-tasks off the
  settings import). `isEmailConfigured()` = host + port + From set.
- **`lib/auth-token-crypto.ts` (pure) + `lib/auth-tokens.ts` (DB).** The split
  mirrors `lib/share-token.ts`: hashing + TTL math are pure/unit-tested; the row
  ops live with `db`. Tokens are **hash-at-rest** (only SHA-256 stored),
  **single-use** (consumed by ONE atomic
  `UPDATE … WHERE consumed_at IS NULL AND datetime(expires_at) > datetime('now') RETURNING …`,
  so two redemptions can't both win and expiry is checked in the same
  statement), and die on any password change (`invalidateAuthTokensForLogin`)
  and on login delete (FK `ON DELETE CASCADE`). Invite TTL 24 h, reset TTL 1 h.
  `kind` ∈ `invite | reset`.
- **`lib/auth-email-content.ts` (pure) + `lib/auth-email.ts` (orchestration).**
  Address validation, the no-enumeration message, the message bodies, and the
  link builder are pure; `sendInviteEmail`/`sendResetEmail` mint a token, build
  the link from the public URL, and hand the composed mail to the chokepoint.
  `canSendAuthEmail()` = `isEmailConfigured()` **and** a public URL is set.
- **`lib/auth-email-ratelimit.ts` (pure).** In-process fixed-window counters
  (family scale); the reset-request action holds the per-email + per-IP Maps.
- **Migration 064** (`064-login-email.ts`): `logins.email` (unique-if-set NOCASE
  via a partial index) + `login_auth_tokens`. Both are login-scoped **global**
  tables (no `profile_id`, not in `lib/owned-tables.ts`).

## Security posture (decided up front)

- **No user enumeration.** `requestPasswordReset` always answers "if that email
  is registered, we've sent a link" — for an unknown address, a throttled
  request, or an instance that can't send. (The calendar-feed no-oracle
  precedent applied to auth.)
- **Rate limiting** on the request endpoint, per-email + per-IP.
- **2FA is never bypassed.** A reset/invite sets the password ONLY; a
  TOTP-enrolled login still needs its code at the next sign-in. Recovery codes
  remain the 2FA escape hatch — email reset must not become a second one.
- **Tokens invalidated by any password change**; expired/used/unknown tokens all
  fail to ONE generic message.
- The `/forgot-password` and `/set-password` routes join the **middleware
  public-path allowlist** (`lib/public-paths.ts`, extracted so a unit test
  covers the set); the real checks are in the Node handlers
  (middleware-is-coarse).

## Config gating (graceful degradation)

Unconfigured SMTP ⇒ every email affordance hides: the "Forgot password?" link on
`/login`, the "Email an invite" option and the per-login "Send invite" button in
Family. No public URL ⇒ the send actions refuse with honest copy ("Couldn't send
the invite — set the public app URL first."), and the SMTP settings card shows a
"needs public URL" note. The admin's manual password reset in Family stays as
the always-available fallback (a family member with no email is still rescued).

## The invite carries the credential (#1434)

Creating a login with **"Email an invite"** checked now creates it
**passwordless**: the form disables the password field and `createLogin` neither
asks for nor accepts one. `logins.password_hash` is still `NOT NULL` — a
nullable-password auth path remains a larger, security-sensitive change we did
not take — so "passwordless" is a hash of freshly generated random bytes that are
immediately discarded. Nobody, admin included, holds a credential for that login
until the invitee spends their token. That is strictly safer than the previous
admin-invented interim password, which stayed valid alongside the invite link.

Consequences, all load-bearing:

- An invite the instance **cannot send** (no email address, SMTP/public URL
  unconfigured) is refused **before** the insert, so a login is never left with a
  credential nobody can claim. The old code created the login and appended a
  note.
- The invite send failing **after** the insert still doesn't roll it back; the
  message says the login has no password yet and to resend from its row.
- The admin's manual **Reset password** in Family remains the rescue path.

## No grantless dead end (#1434)

A login that authenticates but can reach **no profile** used to mint a session,
redirect, and then bounce off `resolveSessionToken` (which resolves a login with
zero accessible profiles to `null`) back to an empty sign-in form, forever, with
no message and a growing pile of unusable "active sessions".

- **Access is part of creating a member.** The create-login form carries an
  initial profile picker (defaulting to a same-named profile when exactly one
  exists), written in the SAME transaction as the login row. Its labels — and the
  Access matrix's and own-profile select's — run through
  `disambiguateProfileNames` (#534), so two same-named profiles are never
  identical rows where granting the wrong one is costliest.
- **Both sign-in doors refuse honestly.** `loginHasProfileAccess` is checked
  after the password (and after the second factor, so the outcome is never
  revealed to someone holding only the password): the action returns
  `NO_PROFILE_ACCESS` (`lib/login-security.ts`), audits `login.no-profile-access`,
  and mints **no** session.
- **A session that outlives its grants is torn down** on resolve rather than left
  as a zombie row the Family screen still counts.
- A member with zero grants is badged **"no access"** on its Logins row.
