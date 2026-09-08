# Security policy

## Report a vulnerability

Report security bugs privately through the repository's **Security → Advisories →
Report a vulnerability** form. Include impact, reproduction steps or a proof of
concept, affected routes/versions/configuration, and suggested remediation.
Use synthetic or redacted data; never include real health records or credentials.

We will acknowledge reports, provide progress updates, and credit reporters who
wish to be named after a fix is released. Authentication, profile isolation,
uploads, file serving, and medical-data disclosure are especially relevant.

Allos is a rolling release. Security fixes land on `main`; self-hosters should
track it or the latest published container image. Older commits and tags do not
receive separate patches.

## Access boundaries

A login is an authentication identity; a profile is a data subject. Enforcement
belongs at server request boundaries and in scoped data access. UI visibility and
middleware's cookie-presence check are not authorization.

[Authentication](lib/auth.ts) resolves live sessions and current grants. Members
can reach granted profiles; admins have access to all profiles. A `read` grant
permits profile reads, exports, and prints; a `write` grant also permits changes.
Profile-owned queries must scope to the authorized profile or authorized set,
including child-table joins. Follow [library ownership rules](lib/AGENTS.md).

Use the guard matching the resource:

| Resource                      | Boundary                                                               |
| ----------------------------- | ---------------------------------------------------------------------- |
| Active profile write          | `requireWriteAccess()`                                                 |
| Another profile's write       | `requireProfileWriteAccess(profileId)`                                 |
| Own login security settings   | `requireLoginWriteAccess()` or the action's explicit credential checks |
| Administrative family changes | `requireAdmin()`                                                       |
| Token-authenticated route     | Validate its token and current scope at that route's boundary          |

Uploads, AI extraction, and minting new profile access are writes. Read-only
members may still manage their own login credentials. Demo restrictions are
additional checks; an apparent write grant does not override them. See
[API tokens](docs/api-tokens.md) for their supported endpoints and live-grant rules.

Existing guards and tests cover specific paths; their presence does not prove
that every query or action is safe. Review the actual path and scope when changing
access. Use the [change and test policy](docs/change-policy.md) for focused
verification, avoiding duplicate scanners and assertions of documentation wording.

## Sessions and credentials

[Session cookies](lib/session-cookie.ts) are `HttpOnly`, `SameSite=Lax`, and
`Path=/`, with no `Domain`. Production uses Secure `__Host-ht_session`; development
uses `ht_session`. The database stores a hash of the random session token and
keeps the active profile server-side.

Sessions have a 30-day sliding expiry and a 90-day absolute ceiling from creation,
enforced by session lookup and purge. Browser-cookie renewal follows the shared
slide policy; activity cannot extend the absolute ceiling.

[Password validation](lib/password-strength.ts) runs offline. User-set passwords
must be 10–200 characters and use at least two of lowercase, uppercase, digits,
and symbols. For usernames of at least three characters, the case-insensitive
check rejects either value containing the other. Passwords are hashed through
[the shared password owner](lib/password.ts).

### Two-factor authentication

Logins can enable TOTP in **Settings → Account & security**. Enrollment requires a
verified code and shows eight one-time recovery codes once. TOTP uses a 30-second
step, six digits, SHA-1, and a ±1-step verification window; the stored last-used
step prevents replay. Owners are [totp.ts](lib/totp.ts) and
[two-factor.ts](lib/two-factor.ts).

After a correct password, an enabled login receives a five-minute challenge token
in a separate hardened cookie. It receives a session only after the second factor
succeeds. Login failures share the password lockout machinery. Recovery codes are
stored as SHA-256 hashes and consumed once; the TOTP secret remains on the login
row. Protect the database and its backups accordingly.

Disabling 2FA requires the current password plus a valid TOTP or recovery code.
Regenerating recovery codes also requires a valid second factor. Administrative
family actions require an admin session but do not request a fresh per-action
second factor.

For operator recovery, `ALLOS_DISABLE_2FA=<username>` accepts a comma-separated,
case-insensitive username list and bypasses those logins' second-factor step.
Password verification still applies, and the bypass is logged and audited.
This override does not clear enrollment or bypass the credential checks for
changing it. Remove the override once a working second factor is restored.

## Audit trail

**Settings → Audit** is admin-only and reads the global `audit_events` table.
[The event vocabulary](lib/audit-actions.ts) includes authentication, second-factor,
session-revocation, medical-file access, share-link, profile, login, and grant
changes. It is not a log of every profile read.

Events store time, acting login/profile when available, action, and coarse target
and detail identifiers. Never log passwords, second-factor codes, raw tokens, or
medical content. Grant diffs include access levels, so read-to-write changes remain
visible. IDs have no foreign keys, preserving the trail after account deletion.

[Audit writes](lib/audit.ts) are best effort: failures are logged without failing
the user's request. The maintenance tick prunes events using the admin-configured
retention window, defaulting to [24 months](lib/retention.ts). Protect and back up
the database using the [backup guide](docs/backups.md).

## Browser response policy

[next.config.js](next.config.js) supplies global headers: 180-day HSTS with
`includeSubDomains` and no preload, `X-Frame-Options: DENY`, `nosniff`,
`strict-origin-when-cross-origin`, and a Permissions Policy disabling camera,
microphone, geolocation, payment, and USB browser APIs.

Public `/share/*` responses additionally receive `no-store, must-revalidate`,
`no-referrer`, and `noindex, nofollow`. Both middleware and the final configured
route-header boundary carry these values so document-cache handling does not
replace the intended share policy.

[The CSP builder](lib/csp.ts) owns the enforced policy;
[middleware](middleware.ts) adds it to matched responses with a fresh request
nonce. The matcher excludes Next static/image/data assets and the streaming Fitbit
Takeout import endpoint. Those exclusions do not remove the route's own
authorization requirements.

Production permits same-origin scripts plus nonced inline bootstrap scripts,
without `unsafe-inline` or `unsafe-eval` for scripts. Development relaxes scripts
for hot reload. Styles retain `unsafe-inline` for the current rendering pipeline.
The remaining directives restrict resources, connections, form destinations, and
base URLs; read the builder for exact values.

Framing is denied except for `/medical/file/*`, which allows same-origin ancestors
and uses `X-Frame-Options: SAMEORIGIN` for stored PDF previews. Other origins remain
excluded. Keep this path decision shared between CSP and the frame header.

## Medical uploads and downloads

[Upload validation](lib/file-sniff.ts) derives MIME from recognized content bytes
and rejects contradictions with the declared file family. Text and unrecognized
formats fall back to attachment-only types; structured health records also pass
through their parser. Magic-byte recognition is not a guarantee that a file is
harmless.

[The medical-file route](<app/(app)/medical/file/[id]/route.ts>) checks the live
session, scopes the record to its active profile, and confines its stored path to
the medical upload directory. It serves only a small MIME allowlist inline and
forces other types to download with `nosniff`. Existing rows retain their stored
MIME; serving does not re-sniff or retroactively validate old uploads.
