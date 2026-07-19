# Outbound email — SMTP foundation + login-lifecycle flows

Status: **shipped** (phase 1 — SMTP config + invite-on-create + self-service reset; issue #985). The **notification email channel is phase 2** (not built).

The internals + load-bearing invariants for outbound email. User-facing setup lives in the README "Email" section; this is the design record.

## Scope

Phase 1 is **auth email only** — invite links and password-reset links. These carry **no PHI** (they name the app and the action, nothing about anyone's health data), which is why the main use case sidesteps email's leakiest-channel problem entirely. A fourth `NotificationChannel` (per-profile address, kind gating) is deliberately out of scope and gets its own issue.

## The pieces

- **`lib/email.ts` — the one sender chokepoint.** The SOLE importer of `nodemailer` (mirroring `lib/notifications/telegram.ts`), enforced by the source-scan test `lib/__tests__/email-chokepoint.test.ts`. It owns TLS enforcement (port 465 implicit, everything else STARTTLS via `requireTLS`), the "not configured ⇒ throw" gate, plaintext-first bodies (no attachments, ever), and the deterministic **test capture** (`EMAIL_TEST_CAPTURE=<file>` appends each send as JSON via nodemailer's `jsonTransport` — read at send time so tests/e2e can set it after import).
- **`lib/settings/email.ts` — global SMTP config.** Stored in the `settings` kv table (one relay serves the instance, like the Telegram bot token). The password is **write-only** in the UI (blank submit keeps it; a "remove" checkbox clears it — the AI-key posture). Env-seeded on first boot by `seedSmtpFromEnv` in `lib/migrations/boot-tasks.ts` (the `seedTimezoneFromEnv`/#875 pattern; keys inlined to keep boot-tasks off the settings import). `isEmailConfigured()` = host + port + From set.
- **`lib/auth-token-crypto.ts` (pure) + `lib/auth-tokens.ts` (DB).** The split mirrors `lib/share-token.ts`: hashing + TTL math are pure/unit-tested; the row ops live with `db`. Tokens are **hash-at-rest** (only SHA-256 stored), **single-use** (consumed by ONE atomic `UPDATE … WHERE consumed_at IS NULL AND datetime(expires_at) > datetime('now') RETURNING …`, so two redemptions can't both win and expiry is checked in the same statement), and die on any password change (`invalidateAuthTokensForLogin`) and on login delete (FK `ON DELETE CASCADE`). Invite TTL 24 h, reset TTL 1 h. `kind` ∈ `invite | reset`.
- **`lib/auth-email-content.ts` (pure) + `lib/auth-email.ts` (orchestration).** Address validation, the no-enumeration message, the message bodies, and the link builder are pure; `sendInviteEmail`/`sendResetEmail` mint a token, build the link from the public URL, and hand the composed mail to the chokepoint. `canSendAuthEmail()` = `isEmailConfigured()` **and** a public URL is set.
- **`lib/auth-email-ratelimit.ts` (pure).** In-process fixed-window counters (family scale); the reset-request action holds the per-email + per-IP Maps.
- **Migration 064** (`064-login-email.ts`): `logins.email` (unique-if-set NOCASE via a partial index) + `login_auth_tokens`. Both are login-scoped **global** tables (no `profile_id`, not in `lib/owned-tables.ts`).

## Security posture (decided up front)

- **No user enumeration.** `requestPasswordReset` always answers "if that email is registered, we've sent a link" — for an unknown address, a throttled request, or an instance that can't send. (The calendar-feed no-oracle precedent applied to auth.)
- **Rate limiting** on the request endpoint, per-email + per-IP.
- **2FA is never bypassed.** A reset/invite sets the password ONLY; a TOTP-enrolled login still needs its code at the next sign-in. Recovery codes remain the 2FA escape hatch — email reset must not become a second one.
- **Tokens invalidated by any password change**; expired/used/unknown tokens all fail to ONE generic message.
- The `/forgot-password` and `/set-password` routes join the **middleware public-path allowlist** (`lib/public-paths.ts`, extracted so a unit test covers the set); the real checks are in the Node handlers (middleware-is-coarse).

## Config gating (graceful degradation)

Unconfigured SMTP ⇒ every email affordance hides: the "Forgot password?" link on `/login`, the "Email an invite" option and the per-login "Send invite" button in Family. No public URL ⇒ the send actions refuse with honest copy ("Couldn't send the invite — set the public app URL first."), and the SMTP settings card shows a "needs public URL" note. The admin's manual password reset in Family stays as the always-available fallback (a family member with no email is still rescued).

## Note: invite still sets an initial password

Creating a login still requires a password (the invite then lets the person set their OWN). The value delivered is that the admin never has to **relay** a password out-of-band — not that the login has no password until claimed. A nullable-password/claim-only auth path was deliberately avoided as a larger, security-sensitive change.
