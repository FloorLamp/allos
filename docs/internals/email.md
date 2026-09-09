# Outbound email

Status: shipped

Email supports login invitations, password resets, and an optional notification
channel. Operator setup lives in the [README](../../README.md#outbound-email).
[Notification architecture](notifications.md) owns routing, suppression, scheduling,
and shared retry budgets; this guide covers email's specific contracts.

## Sending and configuration

[sendEmail](../../lib/email.ts) owns outbound transport and is the sole nodemailer
importer. It sends required plain text with optional HTML, without attachments.
Port 465 uses implicit TLS; other ports require STARTTLS. Connection and greeting
timeouts are 30 seconds, socket timeout 60 seconds. Notification dispatch also has
its own whole-send deadline.

[SMTP settings](../../lib/settings/email.ts) are instance-wide in `settings`,
admin-managed under Settings → Server. Configuration requires a host, valid
resolved port, and From address; user/password are optional. Port parsing falls
back to 587. The UI receives `hasPassword`, never the password: blank submission
keeps the secret and explicit removal clears it. Saving relay configuration
invalidates existing email delivery-health outcomes.

`seedSmtpFromEnv` in [boot tasks](../../lib/migrations/boot-tasks.ts) seeds nonempty
SMTP environment values only when none of the SMTP settings keys already exists.
It does not overwrite later database configuration or fill a partially configured
relay on every boot.

`EMAIL_TEST_CAPTURE` switches sends to JSON transport and appends one JSON line
per message to the named file without using SMTP. It is read at send time and
bypasses the configured-relay gate. Use this existing capture for tests; do not
send real mail or add a second mailbox harness.

## Login email and tokens

The address belongs to `logins.email`, shared by auth and notification mail.
It is unique when set, case-insensitively. Login rows and `login_auth_tokens` are
global authentication data, not profile-owned health rows.

[Auth mail](../../lib/auth-email.ts) composes through
[auth-email-content](../../lib/auth-email-content.ts), mints a token, builds a link
from the public app URL, and calls the sender. It does not authorize the operation;
Server Actions do that. `canSendAuthEmail` requires both SMTP configuration and a
public URL. Sign-in and Family gate their auth-email affordances on that result.
The admin's manual password reset remains available without email.

[Token crypto](../../lib/auth-token-crypto.ts) owns SHA-256 hashing and lifetimes:
24 hours for invites, one hour for resets. [Token storage](../../lib/auth-tokens.ts)
keeps only hashes. Creating a token replaces outstanding tokens of the same kind
for that login. Redemption checks expiry and unused state in one atomic update,
so competing redemptions cannot both succeed. Password changes invalidate the
login's outstanding tokens; deleting a login cascades its token rows.

The set-password action validates password strength before consuming the token.
Success sets the password, invalidates remaining tokens, and destroys the login's
sessions. It does not sign the person in or remove their second factor. Unknown,
expired, and consumed tokens share one error response.

## Reset and invite behavior

Password-reset requests return the same generic message for unknown addresses,
invalid input, throttling, unavailable configuration, and send failure. The
[action](<../../app/(auth)/forgot-password/actions.ts>) owns in-process per-email
and per-IP buckets; [rate-limit policy](../../lib/auth-email-ratelimit.ts) permits
five requests per email and 20 per IP in a fixed one-hour window. These are
per-process counters, not a distributed quota. Log failures server-side without
revealing account existence in the response.

Creating a login with "Email an invite" ignores any supplied password and stores
a hash of discarded random bytes. The invitee establishes their password through
the token. Missing email or unavailable auth-email configuration refuses creation
before insertion. A transport failure after insertion leaves the login in place
and asks the admin to resend or reset its password manually.

Login creation and initial profile grants share a transaction. Authentication
checks profile access after the required credentials, including the second factor,
and refuses a login with no accessible profile before minting a session. Session
resolution removes sessions that lose all profile access. Keep these rules in the
existing [auth](../../lib/auth.ts) and login owners rather than duplicating them in
email code.

## Notification content and recipients

[Email composition](../../lib/notifications/email-core.ts) supports two modes:

- `content-free`, the default, produces a fixed nudge and optional public app link.
  Its builder does not accept the message, so titles, health details, and profile
  names cannot enter through that argument.
- `full` uses the message title and `plainBody(bodyFor(msg, "email"))`, plus URL
  actions as plain links. Callback tokens are omitted.

The login explicitly enables the channel and separately chooses full content.
These preferences and disabled message kinds live in `login_settings`. An absent
content-mode form field saves content-free. Settings' notification test targets
the login's own stored address using its stored content mode.

[Recipient resolution and sending](../../lib/notifications/email.ts) uses managing
logins: explicit profile grants plus own profile, excluding muted profiles and
disabled channels/kinds. Admin access to every profile does not subscribe an admin
to every profile's mail. Addresses are deduplicated after filtering; if surviving
recipients share an address, content-free wins any disagreement.

Button-only message kinds use the existing Web Push deliverability predicate.
An excluded kind or empty audience is a healthy no-op with `delivered: false`.
Each attempted recipient gets a delivery-health outcome. At least one successful
send makes the channel return delivered; it throws only when every attempted
address fails. A partial failure is therefore recorded without failing the whole
email channel. Retry eligibility belongs to shared dispatch and slot scheduling:
do not add an email-specific counter, marker, or queue.
