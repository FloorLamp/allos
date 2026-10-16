# API tokens

`upload:documents` tokens permit uploads, run reports, and supporting reads,
using current grants, excluding downloads. IDs and mappings do not grant access.

## Manage tokens

Under **Settings → Account & security → API tokens**, name the client, choose its
capability, and create a token. Copy it immediately; the secret is shown once.
Use separate device tokens.

A login can have 20 live tokens, formatted `<id>.<secret>`; the ID is public and
only a scrypt hash of the secret is stored. Tokens never expire; revoke unused ones
by last-used time. Revocation applies to the next request. A revoked row stays,
hidden, to block ID reuse; deleting a login removes its tokens.

Members manage their tokens; admins also manage others'. Lists expose names,
capabilities, and usage, never secrets.

## Authenticate and select a destination

Send `Authorization: Bearer <id>.<secret>`. This example assumes `ALLOS_TOKEN` is
set and passes the header through stdin to keep it out of curl's arguments:

```bash
printf 'Authorization: Bearer %s\n' "$ALLOS_TOKEN" | curl -H @- \
  -F file=@labs.pdf 'https://allos.example/api/documents?profile=2'
```

Keep credentials out of files and logs. Upload and inventory need one destination:

- `profile=<id>`; there is no active-profile default.
- `portal=<slug>&patient=<label>`, optionally with `account=<slug>`. Use the
  portal's patient label and Allos's mapping under **Integrations → Patient
  portals**. URL-encode query values. Omit `account` only for a single-account
  portal.

Upload targets may be query parameters or multipart fields; query values win.
Missing, malformed, or conflicting targets return 400. The login must reach and
write the resolved profile, and demo restrictions apply.

Unknown, unmapped, ignored, or ambiguous portal identities all get 404
`error: "unmapped-identity"`. An upload refusal, but not an inventory read or dry
run, records a bounded pending identity for a person to map; repeats update it.

Successful uploads (including dry runs) and sync reports resolving a portal patient
return optional `accountId`: the string `/v1/accounts` row ID,
`portal:<accountId>:<profileId>`. Profile-only requests and patient-less reports omit
it; older servers may omit it. Clients scope it to the Allos instance and
portal/account slugs, and may emit `from: {backend: "allos", id: accountId}`.

## Upload documents

`POST /api/documents` takes multipart `file` parts under the in-app ingest rules
(size, type, content, batch, dedup), sequentially; overflow appears in `skipped`.
`ok: true` means the request was handled; check each file's result.

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

Duplicate and blocked offers create no row (`id: null`). Clinical entries match
across repackaged exports; a partly new export is stored. Review's **blocked from
re-acquisition** controls or a direct upload reverse a block.

### Check a file first

`dryRun=1` (query or form field) stores nothing: no file, row, model call, or
notification. Each `documents` entry has `profile` (`id`, `name`, `decidedBy`),
`verdict` (`rejected`, `duplicate`, `covered`, `would-import`, `would-extract`),
`note`, `duplicates` (same bytes, any readable profile), and `records`: per CCDA,
zip members included, the `patient` and `visits` (`covered` or `new`).
`covered`: every visit is already held. Upload form: **Check first**.

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

Inventory arrays hold SHA-256 file hashes: `held` (stored), `deleted` (blocked by
a person), `covered` (clinical entries already held). Send only hashes in none of
them, from a fresh read: deletion, reassignment, or reprocessing can remove
coverage. Upload enforces the same refusals. No filenames or contents are exposed.

Portal listings need write access to some profile (else 403). They show reachable
and unclaimed accounts, omit portals with none, and expose no URLs or patient
bindings; configure URLs and credentials locally. `software` may be null;
`implicit` marks the default account. Name an account when a portal has several.

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

`npm run upload-docs -- …` accepts repeated `--profile` names or IDs; names
ignore case and whitespace but must be unambiguous.
Each destination dedups independently. `--list` prints writable profiles;
`--dry-run` checks without storing. Exit 0: no failures, duplicates and blocks
included; 1: a failed file or request; 2: bad arguments.

## Developer owners

[api-token-format](../lib/api-token-format.ts): wire parsing, scopes, labels,
rate-limit identity; [api-tokens](../lib/api-tokens.ts): storage and
authentication; [acquirer identity](../lib/acquirer-identity.ts): destination and
report parsing; [routes](../app/api/documents) authorize before domain work.
[Upload outcomes](../lib/document-upload-api.ts),
[coverage](../lib/document-coverage.ts) and
[deletion decisions](../lib/document-tombstones.ts) have owners. Document hash
blocks live in `import_tombstones`, apart from keyed-upsert tombstones.

Register bearer paths in [public-paths](../lib/public-paths.ts), rate-limit before
scrypt verification, authenticate the required scope; middleware registration is
not authorization. Resolve reachability before write access and demo checks
(`accessForProfile` assumes it). Reuse the ingest engine and account gates.
