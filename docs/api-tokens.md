# API tokens

Allos is a login-gated app: every screen and every Server Action authenticates from a
session cookie. An **API token** is the way to let something that is not a browser — a
script, a cron job, a command-line tool on another machine — act as one of your logins.

Tokens live under **Settings → Account & security → API tokens**.

## What a token is

A token is **tied to a login**, and it is **capability-scoped**.

Tied to a login means the token has no permissions of its own. It is a way to _present_
a login, and the instance works out what that login may do at the moment of each
request, from its current role and its current profile grants. Three consequences worth
being explicit about:

- If you take away a login's access to a profile, every token that login holds loses
  that profile at the same instant. There is nothing to hunt down and re-issue.
- If a login is promoted or demoted, its tokens follow immediately.
- Deleting a login deletes its tokens.

Capability-scoped means the token says what it is for. Today there is exactly one
capability:

| Capability         | What it allows                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `upload:documents` | Add medical documents to the profiles this login can write to. It cannot read anything. |

That scope is deliberately **write-only**. A token that leaks can put documents into
your record — which you will see, in Data → Review — but cannot read a single value back
out of the instance. Read capabilities are not implemented; when they are, they will be
separate scopes you opt into per token, and an old token will never silently gain one.

## Creating a token

1. Go to **Settings → Account & security → API tokens**.
2. Give it a name that says where it will live — `laptop CLI`, `home server cron`. The
   name is only for you; it is how you decide which one to revoke later.

   **Mint one token per device**, rather than sharing a single token across machines.
   Revocation is per token, so a per-device token is what lets you retire one laptop —
   or one machine you no longer trust — without interrupting every other client you have
   set up.

3. Choose the capability and press **Create token**.

The token is then shown **once**:

```
17.<the secret half>
```

Copy it now. Allos stores only a scrypt hash of the secret, exactly as it stores
passwords, so there is no way — for you, for an admin, or for anyone who reads the
database file — to display it again. If you lose it, create a new token and revoke the
old one.

The part before the dot is the token's id. It is not secret: it is what lets the server
find the one row to verify against instead of comparing your secret to every token in
the instance.

## Using a token

Send it as a bearer token. Keep it in an environment variable or a secrets file, not in a
command line — command lines show up in shell history and in other users' process lists.

### Uploading documents

`POST /api/documents` takes a multipart body and the profile to file it under:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" \
     -F file=@labs.pdf \
     "https://allos.example/api/documents?profile=2"
```

The `profile` is **required** and can also be sent as a form field. It is never
inferred: filing someone's labs under the wrong person is the mistake this refuses to
risk, so a missing profile is a `400`, not a default.

Uploads go through exactly the same ingest engine as the in-app upload form, so they get
the same size limits, the same content check, the same per-profile deduplication, and the
same Data → Review entry. The response reports **each file** rather than a blanket
success:

```json
{
  "ok": true,
  "profile": 2,
  "documents": [
    { "id": 412, "name": "labs.pdf", "outcome": "stored", "reason": null }
  ]
}
```

`outcome` is one of:

- `stored` — the file is in the record; extraction continues on the server.
- `duplicate` — this profile already had these exact bytes. Nothing new was stored.
  Re-running an upload is safe by design.
- `failed` — the engine refused it, and `reason` says why (too large, unsupported type,
  contents that contradict the file name).

`ok: true` means the request was handled, never that every file landed — always read the
per-file `outcome`.

You can send several `file` parts in one request; they are ingested one at a time, up to
the same batch cap the upload form uses, and any overflow is reported in a `skipped`
count rather than silently dropped.

### Uploading for a portal patient instead of a profile id

An automated acquirer — a tool that signs into a hospital portal and pushes what it finds
— should **not** decide profile ids. A mapping kept in local config on every machine goes
stale, and a stale mapping files one person's records under another. So instead of a
profile, such a tool names the identity the portal showed it:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" \
     -F file=@summary.pdf \
     "https://allos.example/api/documents?portal=ochsner&patient=Jane%20Q.%20Doe"
```

Allos resolves `(portal, patient)` against the mapping you manage under **Integrations →
MyChart**, then intersects the result with what this token may write. A mapping is never a
bypass: a binding says where records belong, not that this token may put them there.

Exactly one form per request — a `profile` **or** a `(portal, patient)` pair. Both
together is a `400`, because preferring one would silently ignore the destination you
named.

If the patient is not mapped, the request is refused with a typed outcome and **nothing is
stored**:

```json
{ "ok": false, "error": "unmapped-identity" }
```

That refusal is the feature. When a new person appears on a portal's proxy list, the
upload fails visibly and becomes a one-tap mapping — it never lands on whichever profile
seemed closest.

### Reporting a run

A run that checked a portal and found nothing new pushes no documents at all — and that is
the common case. Without a report the server would see no trace of it, so "Last checked"
could never move and a perfectly healthy quiet week would look broken. An acquirer
therefore ends every run with:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"nothing-new","portal":"ochsner","patient":"Jane Q. Doe","unchanged":4}' \
     https://allos.example/api/documents/sync-report
```

`status` is `downloaded`, `nothing-new`, or `failed`, alongside optional `inserted`,
`updated`, `unchanged`, `failed` counts and a `message`. It lands as an ordinary sync
event, so Data → Review shows it like any other integration.

`nothing-new` is a **calm success**: it advances "Last checked" and keeps the connection
looking alive. Only `failed` drives the Review failure badge — and a failure deliberately
leaves the previous timestamp standing, so the card keeps showing how long it has really
been since the portal was last read.

### Finding the profile ids

`GET /api/documents/profiles` returns the profiles this token may upload to:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" \
     https://allos.example/api/documents/profiles
```

```json
{ "ok": true, "profiles": [{ "id": 2, "name": "Alex" }] }
```

It lists only the **writable** ones — a read-only grant would only produce a `403` a step
later — and the names are exactly the ones this login already sees in its own profile
switcher, disambiguated the same way. Nothing else is disclosed.

### Rate limits

Both endpoints are rate-limited per token (uploads: 60 requests per 5 minutes). Over the
budget you get a `429` with a `Retry-After` header.

## The command-line tool

`scripts/upload-docs.ts` wraps the two endpoints. It is **dependency-free** — Node 24
stdlib only, nothing from this repo, no database access — so you can copy that single
file to any machine with Node 24 and run it, with no version-skew concern against the
instance it talks to:

```bash
export ALLOS_TOKEN=...            # never passed on the command line
node scripts/upload-docs.ts --url https://allos.example --profile alice labs.pdf scans/*.jpg
```

From a checkout you can also run `npm run upload-docs -- --url … --profile … files…`.

- `--profile` takes a **name or an id** and can be repeated. Names are resolved against
  `GET /api/documents/profiles`, case- and whitespace-insensitively. An ambiguous name is
  an error, not a guess.
- `--list` prints the profiles this token may upload to, and exits.
- Sending one file to two people is two uploads, on purpose: documents are stored and
  deduplicated per profile, so each person's copy dedups against their own record.
- Exit codes: `0` when everything was stored or already present (a duplicate is not a
  failure — a cron re-scanning a folder should not go red for doing its job), `1` when
  any file failed or the instance could not be reached, `2` for bad arguments.

Running the `.ts` file on bare Node prints a one-off
`MODULE_TYPELESS_PACKAGE_JSON` warning on stderr; it is harmless.

The endpoint stays **curl-first**. The script is convenience, not protocol — anything it
does, the two `curl` calls above do.

## Revoking

Press **Revoke** on the token's row. It stops working on the very next request; there is
no cache and no grace period. Revoking is also the right response to "I'm not sure where
that token ended up" — creating a replacement costs seconds.

Revoked tokens disappear from the list. Their row is kept internally so the id is spent
forever and can never be reissued.

## Expiry

There is none, on purpose. A token lives until it is revoked or its login is deleted,
and the list shows you when each one was last used so an unused token is easy to spot
and remove. Time-limited tokens will arrive with a capability that needs them.

## Who sees what

Members manage their own tokens. Admins additionally see every login's tokens — names,
capabilities and last-used times, never secrets — which is the same visibility they
already have over logins and grants, and the only way to notice a stale credential left
behind on someone else's login.

## For developers

- `lib/api-token-format.ts` — the capability vocabulary, the `<id>.<secret>` wire
  format, and the scope-demand rule. Pure, no database.
- `lib/api-tokens.ts` — mint/list/revoke, plus `authenticateApiToken()`, the single
  helper every bearer route authenticates through.
- `lib/document-upload-api.ts` — the upload endpoint's pure decisions: which profile a
  request targets, and the per-file outcome mapping.
- `app/api/documents/route.ts` — the upload endpoint. It hands every file to
  `lib/medical-pipeline::ingestMedicalUpload`, the ONE ingest engine, and adds no gate of
  its own (a second copy would drift from the form's).
- Migration `127-api-tokens.ts` — the `api_tokens` table. It is login-owned (no
  `profile_id`), so it is not in `lib/owned-tables.ts`.

`authenticateApiToken()` **authenticates only**. It answers "which login is this, and
does its token carry the capability this endpoint demands" — nothing more. Whether that
login may write to a particular profile is authorization, it is profile-shaped, and it
stays with the route, which composes the same explicit gate `app/share-target/route.ts`
documents:

```ts
isDemoRestricted(isDemoMode(), login.role) ||
  accessForProfile(login.id, login.role, profileId) !== "write";
```

A token is a way to present a login, never an exemption from what that login may do.

Two rules for anyone adding a bearer route:

- **Put it on the `lib/public-paths.ts` allowlist.** The Edge middleware is a coarse
  cookie-presence check and would answer a tokened POST with a 307 redirect to `/login`,
  re-posting the body at a page route. The allowlist only buys the handler the right to
  answer for itself; the handler's own `authenticateApiToken()` call _is_ the gate.
- **Rate-limit before authenticating.** Verification is scrypt — real CPU and memory per
  attempt, by design — so an unauthenticated caller can make the server work. Key the
  limit on the presented token's id, never its secret, exactly as
  `app/api/integrations/health-connect/ingest` does.
