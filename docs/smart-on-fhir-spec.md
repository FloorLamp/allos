# Spec: SMART on FHIR patient access (provider-portal pull)

Status: **draft** · Owner: TBD · Tracking issue: [#143](https://github.com/FloorLamp/allos/issues/143)

## Problem

The medical pipeline's most painful step is manual: log into a portal, export
a CCD/XDM or FHIR bundle, upload it. SMART on FHIR patient-access APIs
(mandated for US certified EHRs by the 21st Century Cures Act) let the app
pull records directly from the provider. The expensive half already exists —
`lib/fhir.ts` maps patient-access resource types and
`lib/health-record-doc.ts` → `lib/import-persist.ts` give parsed records
provenance, import reports, reprocess, per-document delete, and the #71
read-layer dedup. The missing parts are OAuth against provider endpoints,
endpoint discovery, and an incremental sync engine.

## Scope

**v1 targets Epic patient-facing apps only.** Epic covers the largest share
of US portals (every MyChart instance), publishes an open R4 endpoint
directory, and lets individuals register patient-facing apps. The design
keeps other vendors (Cerner/Oracle Health, athenahealth) reachable later:
everything vendor-specific is confined to the endpoint directory and a small
per-vendor quirks table.

### Non-goals

- **No write-back** (appointment booking, messaging). Read-only
  `patient/*.read` scopes, period.
- **No bulk-data / backend services flow** — this is patient-context SMART
  (authorization-code + PKCE), one human consenting per connection.
- **No hosted intermediary** (1upHealth-style aggregators). Self-hosters
  register their own client id; the app talks to the provider directly. This
  is the privacy posture the app sells — PHI moves provider → user's box,
  never through a third party.
- **No automatic provider matching.** The user picks their provider from the
  bundled directory (or pastes a FHIR base URL); we don't guess.
- **v1 pulls the resource types the parser already maps** (see Sync). New
  types (DiagnosticReport-only labs, Coverage, etc.) are follow-ups.

## Architecture

Four pieces, each mapped to an existing pattern:

| Piece               | Pattern it follows                                         |
| ------------------- | ---------------------------------------------------------- |
| Connection + tokens | Strava OAuth (`lib/integrations/connections.ts`)           |
| Endpoint directory  | Generated dataset (`scripts/gen-*` → committed JSON)       |
| Sync engine         | Strava cursor poll from the hourly tick (`strava-sync.ts`) |
| Persistence         | The deterministic import path (`persistHealthRecordDoc`)   |

### 1. Registry + connection model

- New registry entry `smart-fhir` (`lib/integrations/registry.ts`),
  `kind: "oauth"`, `status: "available"`. One registry entry, many
  connections: unlike Strava, a profile can hold **multiple** connections
  (two health systems), so connection state lives in
  `integration_connections` keyed by a per-connection provider string
  `smart-fhir:<endpointId>` — the existing `(profile_id, provider)` PK then
  gives one row per (profile, portal) with no schema change. `config` JSON
  (the column comment already anticipates "OAuth tokens later") holds:

  ```jsonc
  {
    "endpoint": { "id": "epic-…", "name": "…", "fhirBase": "https://…" },
    "clientId": "…", // the self-hoster's registered app
    "tokens": { "access": "…", "refresh": "…", "expiresAt": 0, "patient": "…" },
    "cursors": { "Observation": "2026-07-01T…", "Condition": "…" }, // per-type _lastUpdated
    "docId": 123, // the living document row (see Persistence)
  }
  ```

- Token posture matches Strava: stored in the DB `config` JSON, protected by
  the same boundary that protects the health data itself (the DB _is_ the
  sensitive asset; encrypting tokens with a key stored beside them adds no
  real security). Disconnect deletes tokens and revokes upstream when the
  vendor supports revocation.

### 2. Endpoint directory + app registration

- `scripts/gen-fhir-endpoints.ts` consumes Epic's published open endpoint
  list (R4) → committed `lib/fhir-endpoints.json` (id, org name, FHIR base
  URL). Refreshed by re-running the generator; a manual "paste a FHIR base
  URL" escape hatch covers endpoints missing from the snapshot.
- **Client registration is per self-hosted instance** and unavoidable
  (Strava has the same property): the operator registers a patient-facing
  Epic app once (redirect URI = `<public URL>/api/integrations/smart-fhir/callback`),
  and enters the client id in **Settings → Server** (global, admin-only —
  one client id serves every profile's connections). README gets a
  step-by-step walkthrough. The redirect URI requires the instance's public
  URL — already a stored setting (`getPublicUrl()`); the connect button is
  disabled with an explanatory hint when it's unset.
- SMART discovery at connect time: fetch
  `<fhirBase>/.well-known/smart-configuration` for the authorization/token
  endpoints; fall back to the CapabilityStatement `security` extension.
  Never hardcode vendor auth URLs.

### 3. OAuth flow (SMART authorization-code + PKCE)

Follows the Strava callback's guard stack exactly, plus PKCE:

1. **Connect** (server action, `requireSession()`): generate `state` +
   PKCE verifier/challenge, persist both single-use on the connection row,
   redirect to the provider's authorize URL with
   `scope=openid fhirUser patient/*.read offline_access`,
   `aud=<fhirBase>`, `code_challenge_method=S256`.
2. **Callback** (`app/api/integrations/smart-fhir/callback/route.ts`):
   **session-gated, not public** — same rationale as Strava (SameSite=Lax
   cookie survives the redirect; tokens bind to the session's active
   profile). Timing-safe single-use state check (`statesMatch` /
   take-and-clear semantics), code + verifier → token exchange,
   shape-validate the response before persisting. The token response's
   `patient` id is stored — every subsequent query is scoped to it.
3. **Refresh**: mirror `getStravaAccessToken` — refresh inside a 5-min
   expiry margin, persist rotated refresh tokens, throw on failure so the
   sync run records a failed `integration_sync_events` row (surfaces in the
   Review inbox, self-clearing on recovery). Epic patient-app refresh
   tokens are long-lived only when the registration requests
   `offline_access`; when a refresh is rejected the connection flips to a
   `reauth` state and the config page shows a Reconnect button.

### 4. Sync engine

Runs from the hourly tick (and a "Sync now" button on the config page),
per connection, mirroring `strava-sync.ts`'s shape (bounded work, cursor
kept on failure, one sync event per run):

- **Resource types (v1):** Observation (category=laboratory + vital-signs),
  Condition, AllergyIntolerance, Immunization, MedicationRequest,
  Procedure, Encounter, FamilyMemberHistory, CarePlan, Goal — exactly the
  `map*Resource` coverage in `lib/fhir.ts`, plus Patient (demographics
  adoption, existing `mapPatientDemographics`).
- **Initial pull:** per type, `GET <fhirBase>/<Type>?patient=<id>&_count=…`
  following `next` page links, with a per-run page budget (Strava's
  `MAX_DETAIL_CALLS` analogue) — a huge chart resumes over several hourly
  runs rather than hammering the provider. Per-type completion is tracked in
  `cursors`.
- **Incremental:** per type, `_lastUpdated=gt<cursor>`; cursor advances only
  after a successful persist. Vendors with unreliable `_lastUpdated` (quirks
  table) fall back to periodic full re-pull; idempotent persistence makes
  that safe.
- **429/5xx:** truncate the run, keep cursors, record the failure — next
  hour resumes. Respect `Retry-After` when present.

### 5. Persistence — the living-document model

Each connection owns **one** `medical_documents` row ("Epic — <org name>"),
created on first successful pull and re-persisted on every sync that
changed anything:

1. Fetched resources are assembled into a **canonicalized** FHIR bundle:
   entries sorted by (resourceType, id), volatile fields stripped
   (`meta.lastUpdated`, bundle timestamp/id) so identical clinical content
   is byte-identical.
2. If the canonical bytes hash-match the stored file → record an
   `unchanged` sync event and stop (free idempotency via the same SHA-256
   content-hash used for uploads).
3. Otherwise write the bundle under the profile's upload dir and run the
   **existing reprocess path**: `persistHealthRecordDoc(profileId, docId,
buffer)` — which clears the document's prior rows and re-imports in one
   transaction (`clearImportedDocumentRows` + `persistDocumentImport`),
   refreshing the `import_report`.

Why one living document instead of a document per sync: appending documents
would grow duplicate physical rows every sync (mitigated on display by
read-layer dedup, but unbounded), while replace-in-place keeps one
provenance home, exercises only code paths that already exist (this _is_
reprocess), and per-sync history is already captured by
`integration_sync_events`. A manual portal export uploaded alongside a
connection remains a separate document; the #71/#134 read-layer dedup
handles the overlap.

Consequences, made explicit in the UI:

- **Disconnect keeps data** (document + rows stay, marked with their
  source); **deleting the document** is the "remove imported data" action,
  exactly like any other document.
- Records the provider deletes upstream disappear on the next sync (the
  bundle no longer contains them; reprocess clears + re-imports). This is
  correct for patient access (corrections/mergers happen) and worth a note
  in the document detail UI.

### 6. Multi-profile

Connections bind to the session's **active profile** at connect time
(Strava precedent) — a parent connects each kid's portal from that kid's
profile. Nothing new needed; `persistHealthRecordDoc` and every read is
already profile-scoped (the scoping test covers new queries automatically).

## Security & privacy notes

- Scopes are read-only and minimal; no `launch` (standalone, not EHR-embedded).
- The callback is session-gated (not on the middleware public allowlist).
- PKCE + single-use timing-safe state; token exchange response
  shape-validated (all Strava-grade guards).
- Raw response capture for debugging reuses `lib/integrations/raw-log.ts`
  (size-capped, newest-N, on-box under `data/` which is gitignored) — PHI
  never leaves the host. Log lines carry counts, never resource contents.
- Fixtures for every test are synthetic bundles (PHI policy); the Epic
  **sandbox** (test patients) is the only live endpoint used in development.

## Failure modes

| Failure                   | Behavior                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Refresh rejected          | `reauth` state, failed sync event → Review inbox, Reconnect button                 |
| Provider 429/5xx          | truncate run, keep cursors, failed event, resume next hour                         |
| Malformed resource        | `map*Resource` returns null → dropped + counted in `import_report` (existing)      |
| Mid-persist crash         | `persistDocumentImport` transaction rolls back; doc never half-imported (existing) |
| Public URL unset          | connect disabled with hint                                                         |
| Endpoint gone / URL moved | sync fails visibly; user can edit the endpoint URL on the connection               |

## Testing

- **Pure:** smart-configuration parsing, PKCE pair generation, authorize-URL
  construction, bundle canonicalization (ordering/stripping — the
  idempotency linchpin), cursor advancement rules, quirks-table dispatch.
- **DB-tier:** full pull → persist → identical re-pull is `unchanged`
  (hash short-circuit); changed bundle reprocesses to exactly the new rows;
  disconnect-keeps-data; delete-removes-rows.
- **e2e:** config page (directory search, connect-disabled-without-public-URL
  hint, connection card states) against seeded fixtures; the OAuth dance
  itself is covered by a mocked token endpoint in the db-tier, not e2e.
- **Manual gate before release:** Epic sandbox end-to-end against a test
  patient, documented as a release checklist item.

## Rollout

1. **PR 1 — plumbing:** registry entry, endpoint directory generator,
   Server-settings client-id field, connect/callback/refresh, connection
   card UI. No sync yet; "connection established" is the demo.
2. **PR 2 — sync:** engine + living-document persistence + sync events +
   Review inbox integration; Epic sandbox validation.
3. **PR 3 — polish:** per-type pull budgets tuning, quirks table, README
   walkthrough, document-detail provenance notes.
4. **Later:** Cerner/Oracle Health directory + quirks; DiagnosticReport
   expansion; `$everything` where supported.

## Open questions

1. **Client-id tier:** global (Settings → Server, one Epic app per
   instance) is proposed — simplest and matches how Epic registration
   works. Per-profile client ids add nothing.
2. **Epic sandbox in CI?** Probably not (external dependency, credential
   management); manual release checklist instead. Revisit if breakage
   recurs.
3. **Observation `category=laboratory` vs `DiagnosticReport`:** some
   providers expose labs only through DiagnosticReport members. v1 ships
   Observation-only and reports coverage gaps via `import_report`; the
   quirks table is the future home for a DiagnosticReport fallback.
4. **Token refresh cadence vs. hourly tick:** refresh-on-use (Strava
   pattern) means a connection idle past the refresh token's lifetime goes
   `reauth`. Acceptable for v1; a keep-alive refresh in the tick is a
   one-line follow-up if it annoys.
