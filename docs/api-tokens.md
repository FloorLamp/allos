# API tokens

API tokens let scripts act as a login. Manage them under **Settings → Account &
security → API tokens**. Permissions follow that login's current role and profile
access on every request; changing grants takes effect without replacing tokens.

## What a token is

A token is login-owned and capability-scoped. The current scope,
`upload:documents`, permits document uploads, run reports, and supporting reads:
writable profile names/IDs, visible portal/account names and slugs, document
hashes, and open sync requests. It does not permit downloading stored documents.

Each endpoint applies its own authorization after authenticating the token.
Knowing a profile ID or portal mapping does not grant access to it.

## Creating a token

1. Open **Settings → Account & security → API tokens**.
2. Name the device or client, choose the capability, and press **Create token**.
3. Copy the token immediately; it is shown once.

Use a separate token per device so revocation can be selective. A login can have
up to 20 live tokens. The wire format is `<id>.<secret>`: the ID is public; only a
scrypt hash of the secret is stored. A lost secret cannot be recovered.

## Using a token

Send `Authorization: Bearer <id>.<secret>`. These examples assume `ALLOS_TOKEN`
is already set and pass the header through stdin to keep the secret out of
curl's arguments. Keep credentials out of committed files and logs.

### Uploading documents

`POST /api/documents` accepts multipart `file` parts and an explicit destination:

```bash
printf 'Authorization: Bearer %s\n' "$ALLOS_TOKEN" | curl -H @- \
  -F file=@labs.pdf 'https://allos.example/api/documents?profile=2'
```

Destination fields may be query parameters or multipart fields; query parameters
win. Supply exactly one of `profile=<id>` or `portal=<slug>&patient=<label>` with
optional `account=<slug>`. Missing, malformed, or conflicting targets return
`400`; there is no active-profile default. The login must be able to reach and
write the destination, and demo restrictions still apply.

Uploads use the in-app ingest engine's size, content, batch, and deduplication
rules. Files are processed sequentially; batch overflow is returned as `skipped`.
Read every per-file result: `ok: true` means the request was handled.

```json
{
  "ok": true,
  "profile": 2,
  "documents": [
    { "id": 412, "name": "labs.pdf", "outcome": "stored", "reason": null }
  ]
}
```

| Outcome     | Meaning and client action                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `stored`    | Stored for processing through the normal Review flow.                                                                  |
| `duplicate` | Same bytes or fully covered clinical entries; nothing stored. Count as `unchanged`.                                    |
| `blocked`   | A user deleted these bytes; nothing stored. Count as `suppressed`, not failed. Stop offering them until allowed again. |
| `failed`    | Inspect `reason`, such as an unsupported type or size refusal.                                                         |

`duplicate` and `blocked` have `id: null` and create no document row. Clinical-entry
coverage can recognize the same records in different export packaging; a partly
new export is stored. A user can reverse a block through Review's
**blocked from re-acquisition** controls or a direct upload.

### Uploading for a portal patient instead of a profile id

Automated portal clients should send the patient label shown by the portal,
rather than maintain their own profile mapping:

```bash
printf 'Authorization: Bearer %s\n' "$ALLOS_TOKEN" | curl -H @- \
  -F file=@summary.pdf \
  'https://allos.example/api/documents?portal=example-portal&account=default&patient=Example%20Patient'
```

Allos resolves the mapping managed under **Integrations → Patient portals**, then
checks write access. `account` can be omitted only when the portal has exactly one
account. Unknown, unmapped, ignored, and ambiguous identities receive the same
`404` with `error: "unmapped-identity"`; nothing is filed. Authenticated upload
refusals can record a bounded pending identity for a person to map. Repeated
sightings update that identity instead of adding rows.

### Reporting a run

Finish each acquisition with `POST /api/documents/sync-report`, including runs
that found nothing new:

```bash
printf 'Authorization: Bearer %s\n' "$ALLOS_TOKEN" | curl -H @- \
  -H 'Content-Type: application/json' \
  -d '{"status":"nothing-new","portal":"example-portal","account":"default",
       "patient":"Example Patient","unchanged":4,"identities":["Example Patient"],
       "contacted":true,"attended":false}' \
  https://allos.example/api/documents/sync-report
```

- `status`: `downloaded`, `nothing-new`, or `failed`.
- Destination: the same profile or portal/patient forms as upload.
- Counts: optional `inserted`, `updated`, `unchanged`, `failed`, `suppressed`;
  each defaults to zero. A suppressed file does not make the run fail.
- `message`: optional, trimmed to 500 characters.
- `identities`: patient labels seen on the portal, verbatim. Entries may also be
  `{ "patient": "Example Patient", "outcome": "declined" }`; see the supported
  outcomes in [the parser](../lib/acquirer-identity.ts).
- `contacted`: whether the client actually checked the portal. Set false for
  delivery of files already on disk.
- `attended`: whether a person participated. Set false for scheduled runs.
  Both flags default to true when absent, preserving older clients' behavior.

A successful check, including `nothing-new`, advances **Last checked**. Delivery
alone and failed checks do not. An attended check or a successful unattended check
answers an open sync request; delivery alone and unattended failures leave it open.
See [patient portal behavior](integrations.md#patient-portals).

Reporting against a portal account requires write access to a profile mapped
under it; before any patient is mapped, write access to any profile suffices.
An inaccessible account gets the same `404` as an unknown account, without
recording state. Per-patient writes remain limited to writable profiles.

Authorized reports accept discovered identities even when the run failed or its
target patient is unmapped. Labels are sanitized, deduplicated, and capped;
already mapped or ignored labels do not become pending again. The optional
`discovered` response counts newly pending labels, including on an unmapped-target
`404`; it is absent when none are new.

### Reporting a failure that never reached a patient

Only `status: "failed"` may name a portal/account without a patient. For example,
send `{"status":"failed","portal":"example-portal","account":"default",
"message":"Portal login failed","contacted":true,"attended":false}` to the
same reporting endpoint.

This records an account-level run report shown in Patient portals, not a
profile's sync event. It uses the same account authorization and ambiguity rules.
Successful statuses still require a destination patient or profile.

### Asking what allos already holds

`GET /api/documents/held` accepts the upload's destination query parameters and
requires the same write access:

```bash
printf 'Authorization: Bearer %s\n' "$ALLOS_TOKEN" | curl -H @- \
  'https://allos.example/api/documents/held?profile=2'
```

```json
{
  "ok": true,
  "profile": 2,
  "held": ["ab12…"],
  "deleted": ["cd34…"],
  "covered": ["ef56…"]
}
```

The lists contain SHA-256 hashes of file bytes:

- `held`: currently stored documents.
- `deleted`: user-deleted bytes that automated upload will refuse.
- `covered`: offered bytes whose clinical entries are already held in other
  documents. Coverage is recomputed on each read; deletion, reassignment, or
  reprocessing can make the hash disappear from this list.

Send files whose hashes appear in **none** of the three lists. Query current
inventory instead of permanently caching a previous upload or duplicate verdict.
The upload endpoint independently enforces deletion and coverage refusals.
Inventory returns no filenames or document contents, and an unmapped read does
not create a pending identity.

### Finding the profile ids

`GET /api/documents/profiles` returns
`{"ok":true,"profiles":[{"id":2,"name":"Example Patient"}]}` for the login's
writable profiles. Names use the same disambiguation as the profile switcher.
Read-only profiles are omitted; demo-restricted tokens receive an empty list.

### Finding the portal and account slugs

`GET /api/documents/portals` returns visible registry entries:

```json
{
  "ok": true,
  "portals": [
    {
      "slug": "example-portal",
      "name": "Example Portal",
      "software": "mychart",
      "accounts": [
        { "slug": "default", "name": "Default login", "implicit": true }
      ]
    }
  ]
}
```

A login needs write access to at least one profile; otherwise this endpoint returns
`403`. Accounts are filtered by profile reachability, and portals with no visible
accounts are omitted. Unclaimed accounts remain visible for setup. The response
contains no portal URLs or patient bindings; configure the URL and credentials
locally. Use the returned slugs, and select `account` explicitly when multiple
accounts exist. `software` may be null; `implicit` identifies the default account.

### Finding open sync requests

`GET /api/documents/requests` returns `{"ok":true,"requests":[...]}` for open,
unexpired requests on writable profiles. Each entry has `portal`, `account`,
`reason`, and `expires` (a date). It exposes no patient labels or portal URLs.
This is a list clients may act on, without claiming or acknowledging requests;
the ordinary run report answers them. Demo-restricted tokens receive `403`.

### Rate limits

Limits apply per presented token ID, in separate endpoint budgets: uploads allow
60 requests per five minutes; profiles, portals, held, requests, and sync reports
allow 120 each. A refusal returns `429` and `Retry-After`. Malformed credentials
share an anonymous rate-limit bucket within each endpoint.

## The command-line tool

[upload-docs.ts](../scripts/upload-docs.ts) runs on Node 24 without repository
packages or database access:

```bash
node scripts/upload-docs.ts --url https://allos.example --profile 2 labs.pdf
```

It reads `ALLOS_TOKEN` from the environment. From a checkout, use
`npm run upload-docs -- --url … --profile … files…`.

- `--profile` accepts a name or ID and can repeat for multiple destinations.
  Names resolve case- and whitespace-insensitively; ambiguity is an error.
- `--list` prints writable profiles and exits.
- Each destination receives its own upload and deduplicates independently.
- Exit codes: `0` for non-failed outcomes, including duplicates and blocks;
  `1` for a failed file or request; `2` for invalid arguments.

## Revoking

Press **Revoke** on a token's row. It is rejected on subsequent authentication,
with no cache or grace period. Its row remains to prevent ID reuse but disappears
from the management list. Deleting a login deletes its tokens.

## Expiry

Tokens have no automatic expiry. Use the last-used time to identify and revoke
unused credentials.

## Who sees what

Members manage their own tokens. Admins can also list and revoke other logins'
tokens. Lists expose names, capabilities, and last-used times, never secrets.

## For developers

- [api-token-format.ts](../lib/api-token-format.ts) owns wire parsing, scope
  vocabulary, UI descriptions, and the public-ID rate-limit key.
- [api-tokens.ts](../lib/api-tokens.ts) owns mint/list/revoke and
  `authenticateApiToken()`. Tokens are login-owned, not profile-owned.
- [acquirer-identity.ts](../lib/acquirer-identity.ts) owns destination/report
  parsing and explicit response shapes. The [routes](../app/api/documents)
  authenticate and authorize before invoking domain readers/writers.
- [document-upload-api.ts](../lib/document-upload-api.ts) classifies upload
  outcomes. Uploads use `ingestMedicalUpload`, the shared ingest engine.
- [document-coverage.ts](../lib/document-coverage.ts) recomputes coverage from
  stored evidence. [document-tombstones.ts](../lib/document-tombstones.ts)
  records user deletion decisions in `import_tombstones`; it is consulted at
  ingest, separately from keyed-upsert `TOMBSTONE_TABLES`.

For a bearer route, register the cookie-free path in
[public-paths.ts](../lib/public-paths.ts), rate-limit **before** scrypt verification,
and call `authenticateApiToken()` for the required scope. Middleware registration
does not authorize the request. Resolve profile reachability before checking
write access, and apply demo restrictions; `accessForProfile()` alone assumes
reachability. Portal account gates likewise precede discovery and report writes.
