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
- `duplicate` — this profile already had this content. Nothing new was stored. Re-running
  an upload is safe by design. Two recognitions answer `duplicate`, and `reason` says
  which: the same **bytes**, or — for a health record (CCD/XDM/SMART Health Card/FHIR) —
  the same **clinical entries** arriving in different packaging. The second one matters if
  you collect from a portal: a portal regenerates its export container on every request,
  so two collections of the same visit list never share a content hash while every entry
  id inside is identical. allos compares those ids, so repackaging the same records will
  keep landing here — the thing to change is what you collect, not how you package it. A
  partly overlapping export (one that genuinely carries a visit the other did not) is
  **not** a duplicate and is stored. A records-duplicate refusal is **remembered**: those
  bytes come back as `covered` in the inventory below, so you can stop offering them
  without keeping any memory of your own.
- `failed` — the engine refused it, and `reason` says why (too large, unsupported type,
  contents that contradict the file name).
- `blocked` — **a person deleted these exact bytes in allos**, and the deletion is
  remembered. The file was refused and nothing was stored. This is not a failure and
  retrying will never help: the right response is to stop offering it, which the
  inventory below lets you do without transferring anything. A user can reverse it from
  **Data → Review → blocked from re-acquisition**, or by uploading the file themselves.

`ok: true` means the request was handled, never that every file landed — always read the
per-file `outcome`.

`id` is `null` for `duplicate` and `blocked`, because **no `medical_documents` row is
created on either path**. Both are events, not documents, and the run's sync report is
their record — count them `unchanged` and `suppressed` respectively. (The in-app upload
form still lands a visible "skipped" row for a duplicate: there the row is the feedback a
person needs. A retry through this endpoint stays idempotent in the table.) This holds for
the clinical-entry duplicate too, and it is load-bearing there: since a portal's container
is never byte-stable, a daily re-collection would otherwise land a fresh marker row every
single run. Nothing being stored is also why the inventory grew a third list — with no row
and no hash to point at, a refused duplicate would otherwise be indistinguishable from a
document allos has never seen.

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
     "https://allos.example/api/documents?portal=ochsner-mychart&patient=Jane%20Q.%20Doe"
```

Allos resolves the identity against the mapping you manage under **Integrations → Patient
portals**, then intersects the result with what this token may write. A mapping is never a
bypass: a binding says where records belong, not that this token may put them there.

If the portal has **more than one login** in your household, add `&account=<slug>` — the
short id allos minted for the nickname you gave that login. A patient label is unique per
login, not per portal, so two accounts can both show "SMITH, ALEX" meaning two different
people. Omit `account` and allos resolves it only when the portal has exactly one login;
with more than one the request is **refused rather than guessed**, because guessing which
person's login a run came from is how records land on the wrong profile.

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
seemed closest. A patient the household has explicitly **ignored** answers identically:
the endpoint never reveals which of the two it was.

Allos also **remembers what it refused**. The identity appears on **Integrations →
Patient portals**, which hands the whole page over to mapping while anyone is waiting,
with when it was first and last seen, and maps to a profile in one tap — spelled exactly as the portal spelled it, so nobody has to
retype a label they never saw. Repeated sightings update that one entry rather than
piling up, only an authenticated request is ever recorded, and the list is bounded per
login.

### Reporting a run

A run that checked a portal and found nothing new pushes no documents at all — and that is
the common case. Without a report the server would see no trace of it, so "Last checked"
could never move and a perfectly healthy quiet week would look broken. An acquirer
therefore ends every run with:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"nothing-new","portal":"ochsner-mychart","patient":"Jane Q. Doe",
          "unchanged":4,"identities":["Jane Q. Doe","SMITH, ALEX"]}' \
     https://allos.example/api/documents/sync-report
```

`status` is `downloaded`, `nothing-new`, or `failed`, alongside optional `inserted`,
`updated`, `unchanged`, `failed` counts, a `message`, and an optional `account`. It lands
as an ordinary sync event, so Data → Review shows it like any other integration — and it
is recorded against the identity it names, so each mapped patient gets its own
"Last checked".

**Who may report.** A report writes state onto the portal login it names — its pending
list, its run report, whose channels a sync reminder reaches — so the token's login must
hold **write access to at least one profile mapped under that login**; before any
patient is mapped (first contact), write access to any profile is enough. A token
without that is answered with the same `404` an unknown login gets, and **records
nothing** — the endpoint stays deliberately unable to confirm which portal logins exist.

Counts are optional and default to `0`. Alongside `inserted` / `updated` / `unchanged` /
`failed`, report **`suppressed`** — how many documents allos refused because a user had
deleted them (the `blocked` outcome). It lands in the same accounting column the app
already uses for a blocked re-import, so Data → Review renders "2 new · 1 suppressed"
rather than quietly losing the document. A suppressed document is **not** a failure and
never makes a run report `failed`.

**`identities` is how mapping actually happens.** Report the portal's patient list
verbatim — exactly the strings the proxy list showed — and every one that is not already
mapped or ignored appears on the card ready to bind. Nobody has to predict how a portal
renders a name. The list is accepted even when the run itself failed or its own patient is
unmapped (a first run has nothing bound yet), sanitized, de-duplicated, and capped.

The response echoes `discovered` so a tool can say "2 **new** patients need mapping in
allos". It counts identities that were **not already waiting or already answered**, so a
steady-state run reporting the same list every hour reports nothing new: once there is
nothing left to map, the field is **absent**, which is how a tool knows setup is finished.
It is echoed on the `404` refusal too — a first run's own patient is unmapped, so that
refusal is the only place the tool hears how much setup is left.

`nothing-new` is a **calm success**: it advances "Last checked" and keeps the connection
looking alive. A failure deliberately leaves the previous timestamp standing, so the card
keeps showing how long it has really been since the portal was last read. A `failed`
report that names a mapped patient drives that profile's Review failure badge.

### Reporting a failure that never reached a patient

The likely way an acquirer breaks is **before** it reaches anybody: the portal's login
page changed, the Document Center moved. That is a fact about the portal login, true of
every patient on it and of none in particular, so a `failed` report may name a portal
alone:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"failed","portal":"baptist-health",
          "message":"portal login page changed"}' \
     https://allos.example/api/documents/sync-report
```

Add `"account"` when the portal has more than one login — the same omitted-account rule
as everywhere else: allos resolves an omitted login only when there is exactly one, and
**refuses rather than guesses** when there are several, because "one of your two logins is
failing" is not something anyone can act on.

Only `failed` may do this. `downloaded` and `nothing-new` are claims about a patient's
records and still require a target, with the same `400` they always gave.

Such a report has no profile — that is what makes it portal-level — so it lands as a
**run report against the portal login** rather than as a profile's sync event, and shows
in the status sentence on **Integrations → Patient portals**. The same is true of a first run whose own
patient is not mapped yet: refused, nothing filed, but the run is no longer invisible.

### Asking what allos already holds

The problem this solves is silent and permanent. A client that remembers locally which
documents it has sent is recording **its own past behaviour**, not allos's current state.
The two diverge the moment a document is deleted in allos: the client believes it already
sent that document so it never sends it again, allos no longer has it, and nothing on
either side notices. A daily sync keeps reporting success while the document simply is
not there.

`GET /api/documents/held` answers what an identity currently has, using the **same
destination parameters** as the upload:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" \
     "https://allos.example/api/documents/held?portal=ochsner-mychart&patient=Jane%20Q.%20Doe"
```

```json
{
  "ok": true,
  "profile": 7,
  "held": ["ab12…"],
  "deleted": ["cd34…"],
  "covered": ["ef56…"]
}
```

- `held` — content hashes (sha-256 of the file bytes) allos has stored for this profile.
- `deleted` — hashes a **user deleted**. Offering one of these back is refused with the
  `blocked` outcome above.
- `covered` — hashes allos **refused as duplicates**: it stored nothing, but it already
  holds every clinical entry those bytes carry, under different packaging. Sending one
  again is pure waste — it is refused identically every time.

**Send exactly the hashes in none of the three lists.** That rule is what makes the
contract safe for a client with no local state at all — you need no memory of your own,
which is precisely what made the naive design fail. A hash missing from all three after you
previously sent it means the document is genuinely gone _without_ a deliberate deletion
(lost, corrupted): re-sending it is correct, and that is the reconciliation this endpoint
exists for.

**Why `covered` has to come from the server.** A duplicate refusal stores nothing, so
without this list the refused hash was in neither of the other two and the rule told you to
send it again — every run, forever, for a file that can never land. Remembering the
`duplicate` verdict locally is not a fix: the verdict is not stable. Delete the document
whose entries made this one redundant and those bytes become storable again, and nothing
would tell a client holding its own memory — it would skip a document allos would now
accept. So the list is **recomputed on every read**: while the covering document is held
the hash is in `covered`, and the moment that document is deleted, reassigned away, or
reprocessed into a different entry set, the hash silently leaves and you offer it again.
Nothing special is signalled; the next answer is simply different.

The list is additive: a client written against the older two-list contract keeps working
untouched — it just keeps re-offering what this list would have told it to skip.

Do not treat `deleted` as advisory. The upload path enforces it independently, so a client
that ignores the list still cannot resurrect anything — it just wastes the bytes. The same
is true of `covered`, which costs the bytes plus a re-parse.

`profile=<id>` works here too, for debugging by hand. The gate is the upload's: the same
`upload:documents` scope (a token that may send bytes may know what is held), write access
to the resolved profile, and the same `unmapped-identity` refusal for a patient that is not
mapped. Hashes only — no filenames, dates, or counts.

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

### Finding the portal and account slugs

The portal and login slugs are **allos-minted vocabulary**. Rather than transcribing them
into local config by hand — where a typo becomes an `unmapped-identity` refusal that is
deliberately indistinguishable from every other cause — a tool **ingests** them:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" \
     https://allos.example/api/documents/portals
```

```json
{
  "ok": true,
  "portals": [
    {
      "slug": "ochsner-mychart",
      "name": "Ochsner MyChart",
      "software": "mychart",
      "accounts": [
        { "slug": "default", "name": "Default login", "implicit": true },
        { "slug": "mom", "name": "Mom", "implicit": false }
      ]
    },
    {
      "slug": "baptist-health",
      "name": "Baptist Health",
      "software": null,
      "accounts": [
        { "slug": "default", "name": "Default login", "implicit": true }
      ]
    }
  ]
}
```

- **Slugs and names only — never an address.** There is nothing in this payload that
  could aim a tool anywhere; allos has no address column to disclose. The tool still
  binds `slug → URL` locally and pins it on first use. This only guarantees the slug half
  of that binding is spelled the way allos spells it.
- **`implicit`** lets a tool derive the omitted-account rule for itself: exactly one
  account (the implicit one) means it may omit `account` on the wire; more than one means
  it must name one. It can say so at _config_ time instead of discovering it as a refusal
  at _run_ time.
- **`software`** lets it sanity-check what it has been pointed at before the first
  sign-in.
- **No patient labels.** Mapped, pending and ignored bindings are all absent — the tool
  discovers patients from the portal itself, and which patients a household mapped or
  declined is household information this token never reveals.
- **Only the portals and logins this token can reach.** An account nickname is household
  composition spelled out, so an account claimed by profiles this login cannot reach is
  withheld, and a portal whose accounts are _all_ withheld does not appear at all. An
  admin reaches every profile and therefore still gets the whole registry. A portal
  nobody has bound a patient to yet is visible to anyone who could set it up — bindings
  only exist after a run, so otherwise `init` could never learn the slug of a portal
  created a minute ago.

Same `upload:documents` scope: knowing where you may push is part of the push capability.
The visibility gate mirrors the card's — a login with write access to at least one profile
— so a read-only-everywhere caregiver token gets a `403` rather than an empty list.

**`tool init` recipe.** Fetch the list, write the slugs into local config, and prompt only
for what allos genuinely does not know:

```bash
curl -sS -H "Authorization: Bearer $ALLOS_TOKEN" \
     https://allos.example/api/documents/portals \
  | jq -r '.portals[] | "\(.slug)\t\([.accounts[].slug] | join(","))"'
# ochsner-mychart   default,mom
# baptist-health    default
```

For each portal: ask the operator for the URL, and — when the portal has more than one
account — which account slug _this machine's_ login is. Re-running `init` picks up newly
added portals and logins; nothing else about the household changes hands.

### Rate limits

Every endpoint is rate-limited per token (uploads: 60 requests per 5 minutes; the two
config reads and the sync report: 120 per 5 minutes, each in its own budget so a chatty
`init` cannot consume the upload allowance). Over the budget you get a `429` with a
`Retry-After` header.

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
- `app/api/documents/held/route.ts` — the inventory endpoint. It composes the upload's
  gate and answers from three readers: `heldDocumentHashes` (stored bytes),
  `tombstonedDocumentHashes` (deletions) and `coveredDocumentHashes` (duplicate refusals).
- `lib/document-coverage.ts` — the coverage marker (#1828): written when an automated
  client's offer is refused as a records-duplicate, and read back as the `covered` list.
  Evidence is stored — which bytes were offered, which clinical key covered them — and the
  verdict is recomputed on every read against the documents the profile holds now, so a
  delete/reassign/reprocess needs no invalidation hook. Deliberately NOT the tombstone
  table: that records a person's decision, this records the engine's, and a human re-upload
  clears the one while it simply re-earns the other.
- `lib/document-tombstones.ts` — the content-hash document tombstone: written on delete,
  consulted on the acquirer ingest path, cleared by a human upload or the Data → Review
  allow-again action. It reuses the `import_tombstones` table under
  `target_table = 'medical_documents'` and is deliberately NOT a member of
  `TOMBSTONE_TABLES` (those are consulted by the keyed upserts; this one is consulted at
  ingest).
- Migration `127-api-tokens.ts` — the `api_tokens` table. It is login-owned (no
  `profile_id`), so it is not in `lib/owned-tables.ts`.
- Migration `134-tombstone-label.ts` — the nullable `label` on `import_tombstones`, so a
  blocked document can be named in the UI (the natural key is an opaque hash).
- Migration `138-document-coverage-markers.ts` — the `document_coverage_markers` table:
  one row per (profile, offered hash), refreshed on re-offer. Profile-owned, so it is in
  `lib/owned-tables.ts` and cleared with the profile; it holds no health data and is out of
  the portable export.

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
