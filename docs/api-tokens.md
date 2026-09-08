# API tokens

API tokens let scripts act as a login within a capability. The current scope,
`upload:documents`, permits document uploads, run reports, and supporting reads;
it does not permit downloading stored documents. Each request uses the login's
current role and profile grants. Knowing an ID or portal mapping does not grant
write access.

## Manage tokens

Under **Settings → Account & security → API tokens**, name the client, choose its
capability, and create a token. Copy it immediately; the secret is shown once.
Use separate tokens for devices you may revoke independently.

A login can have 20 live tokens. The format is `<id>.<secret>`: the ID is public,
and only a scrypt hash of the secret is stored. Tokens do not expire automatically.
Revoke unused credentials using their last-used times. Revocation takes effect on
subsequent authentication without a cache or grace period. The revoked row remains
to prevent ID reuse but disappears from management lists; login deletion removes
its tokens.

Members manage their own tokens. Admins can also list and revoke other logins'
tokens. Lists expose names, capabilities, and usage times, never secrets.

## Authenticate and select a destination

Send `Authorization: Bearer <id>.<secret>`. This example assumes `ALLOS_TOKEN` is
set and passes the header through stdin to keep it out of curl's arguments:

```bash
printf 'Authorization: Bearer %s\n' "$ALLOS_TOKEN" | curl -H @- \
  -F file=@labs.pdf 'https://allos.example/api/documents?profile=2'
```

Keep credentials out of committed files and logs. Upload and inventory requests
need exactly one destination:

- `profile=<id>`; there is no active-profile default.
- `portal=<slug>&patient=<label>`, optionally with `account=<slug>`. Use the
  portal's patient label and Allos's mapping under **Integrations → Patient
  portals**. URL-encode query values. Omit `account` only for a single-account
  portal.

Upload targets may be query parameters or multipart fields; query values win.
Missing, malformed, or conflicting targets return 400. The login must reach and
write the resolved profile, and demo restrictions apply.

Unknown, unmapped, ignored, or ambiguous portal identities receive the same 404
with `error: "unmapped-identity"`. Authenticated upload refusals can record a
bounded pending identity for a person to map; repeated sightings update it.
An unmapped inventory read creates no pending identity.

## Upload documents

`POST /api/documents` accepts multipart `file` parts. It uses the in-app ingest
engine's size, type, content, batch, and deduplication rules. Processing is
sequential; batch overflow appears in `skipped`. Inspect every file result:
`ok: true` means the request was handled, not that every file was stored.

```json
{
  "ok": true,
  "profile": 2,
  "documents": [
    { "id": 412, "name": "labs.pdf", "outcome": "stored", "reason": null }
  ]
}
```

| Outcome     | Client action                                                     |
| ----------- | ----------------------------------------------------------------- |
| `stored`    | Continue through the normal Review flow.                          |
| `duplicate` | Count as `unchanged`; bytes or clinical entries are already held. |
| `blocked`   | Count as `suppressed`, not failed; a person deleted these bytes.  |
| `failed`    | Inspect `reason` for the refusal.                                 |

Duplicate and blocked offers create no row and return `id: null`. Clinical-entry
coverage can recognize differently packaged exports; partly new exports are stored.
A person can reverse a block through Review's **blocked from re-acquisition**
controls or a direct upload.

## Report an acquisition run

Send JSON to `POST /api/documents/sync-report` after each acquisition, including
one that found nothing new:

```json
{
  "status": "nothing-new",
  "portal": "example-portal",
  "account": "default",
  "patient": "Example Patient",
  "unchanged": 4,
  "identities": ["Example Patient"],
  "contacted": true,
  "attended": false
}
```

- `status` is `downloaded`, `nothing-new`, or `failed`. Supply the same destination
  fields as upload.
- Optional counts are `inserted`, `updated`, `unchanged`, `failed`, and
  `suppressed`, each defaulting to zero. Suppression is not a failure.
- Optional `message` is trimmed to 500 characters.
- `identities` contains patient labels seen on the portal. Entries can also be
  `{ "patient": "Example Patient", "outcome": "declined" }`; supported outcomes
  live in [the parser](../lib/acquirer-identity.ts).
- `contacted` says the client checked the portal; use false for delivering files
  already on disk. `attended` says a person participated; use false for scheduled
  runs. Both default to true when absent.

A successful check advances **Last checked**. Delivery alone and failed checks do
not. An attended check or successful unattended check answers an open sync request;
unattended failures and delivery alone leave it open. See
[patient portal behavior](integrations.md#patient-portals).

Account authorization precedes report and discovery writes: the login needs write
access to a mapped profile, or to any profile while the account has no mapped
patients. Inaccessible and unknown accounts get the same 404 without recording
state. Patient writes remain limited to writable profiles.

Authorized reports accept discovered labels even after a failed run or for an
unmapped target. Labels are sanitized, deduplicated, and capped; mapped or ignored
labels do not become pending again. A `discovered` response field counts newly
pending labels, including on an unmapped-target 404; zero omits the field.

Only `status: "failed"` may name a portal/account without a patient. This records
an account-level report, such as a portal-login failure, rather than a profile sync
event. Successful statuses still require a patient or profile destination.

## Read inventory and destinations

All these endpoints require `upload:documents`:

| GET endpoint              | Response                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/api/documents/held`     | `ok`, `profile`, and arrays `held`, `deleted`, `covered`. Uses the upload destination and write gate.                          |
| `/api/documents/profiles` | `ok`, `profiles: [{id, name}]` for writable profiles, with disambiguated names. Demo-restricted tokens receive an empty list.  |
| `/api/documents/portals`  | `ok`, `portals: [{slug, name, software, accounts: [{slug, name, implicit}]}]`.                                                 |
| `/api/documents/requests` | `ok`, `requests: [{portal, account, reason, expires}]` for open, unexpired requests on writable profiles. `expires` is a date. |

Inventory arrays contain SHA-256 file hashes: `held` is stored content, `deleted`
is deliberately blocked content, and `covered` is offered content whose clinical
entries are already held. Send hashes in none of these lists. Query fresh inventory:
deletion, reassignment, or reprocessing can remove coverage. Upload independently
enforces these refusals. Inventory exposes no filenames or document contents.

Portal listings require write access to at least one profile or return 403.
Accounts are filtered by reachability; unclaimed accounts remain visible for setup,
and portals without visible accounts are omitted. `software` may be null and
`implicit` marks the default account. Use returned slugs, choosing an account
explicitly when several exist. Configure portal URLs and credentials locally;
the response exposes neither URLs nor patient bindings.

Requests expose no patient labels or portal URLs and do not claim or acknowledge
work; the ordinary run report answers them. Demo-restricted tokens receive 403.

## Limits and CLI

Each endpoint has a separate five-minute budget per presented token ID: 60 uploads
or 120 requests to each supporting endpoint. Limits return 429 with `Retry-After`;
malformed credentials share an anonymous bucket within that endpoint.

[upload-docs.ts](../scripts/upload-docs.ts) runs on Node 24 without repository
packages or database access, reading `ALLOS_TOKEN`:

```bash
node scripts/upload-docs.ts --url https://allos.example --profile 2 labs.pdf
```

From a checkout, `npm run upload-docs -- --url … --profile … files…` also works.
`--profile` accepts names or IDs and can repeat; names ignore case and normalize
repeated or surrounding whitespace, and ambiguity is an error. Each destination uploads and deduplicates
independently. `--list` prints writable profiles. Exit codes are 0 for non-failed
outcomes, including duplicates/blocks; 1 for a failed file/request; 2 for bad arguments.

## Developer owners

[api-token-format](../lib/api-token-format.ts) owns wire parsing, scopes, labels,
and rate-limit identity; [api-tokens](../lib/api-tokens.ts) owns token storage and
authentication. [Acquirer identity](../lib/acquirer-identity.ts) owns destination
and report parsing; [routes](../app/api/documents) authorize before domain work.
[Upload outcomes](../lib/document-upload-api.ts),
[coverage](../lib/document-coverage.ts), and
[deletion decisions](../lib/document-tombstones.ts) have existing owners. Document
hash blocks live in `import_tombstones`, separately from keyed-upsert tombstones.

Register bearer paths in [public-paths](../lib/public-paths.ts), rate-limit before
scrypt verification, and authenticate the required scope. Middleware registration
is not authorization. Resolve profile reachability before write access and demo
checks; `accessForProfile` alone assumes reachability. Reuse the ingest engine and
account gates instead of adding another upload or authorization path.
