# SMART on FHIR patient access

Status: **draft, not implemented**. Tracking issue:
[#143](https://github.com/FloorLamp/allos/issues/143).
[Downloaded record import](epic-mychart-integration.md) is shipped. This document
owns the proposed direct OAuth pull design.

## Scope and existing owners

Start with Epic patient-facing access: a person selects a portal, consents to
read access, and connects it to an Allos profile. Self-hosters register their own
application. No write-back, bulk/backend-services flow, hosted intermediary, or
automatic provider matching. Other vendors and additional resource coverage are
follow-ups driven by concrete gaps.

| Responsibility                       | Existing owner to extend                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Source metadata and connection state | `lib/integrations/registry.ts`, `lib/integrations/connections.ts`                                    |
| Scheduled and manual pulls           | `lib/integrations/pull-runners.ts`, `lib/integrations/pull-tick.ts`, `lib/integrations/pull-sync.ts` |
| Resource mapping                     | `lib/fhir/bundle.ts` and its shared mappers                                                          |
| Document persistence                 | `lib/health-record-doc.ts`, `lib/import-persist.ts`                                                  |

Follow the [sync contract](internals/integrations-sync.md). Add the connector
through those owners; reuse import mappings and document writes.

## Connections and authorization

One proposed `smart-fhir` registry entry supports several portal connections per
profile. Store each connection in `integration_connections`, keyed by
`(profile_id, source_id)` with source ID `smart-fhir:<endpointId>`. Its config
holds the endpoint identity/base URL, tokens and expiry, authorized FHIR patient
ID, sync progress, and living-document ID. Extend registry lookup and pull
execution to resolve these connection IDs; current single-source runners do
not provide multi-portal dispatch automatically.

Propose a public client with PKCE and one instance-wide client ID in admin-only
**Settings → Server**. The operator registers the callback at
`<public URL>/api/integrations/smart-fhir/callback`; disable Connect with an
explanation when required setup is missing. Keep credentials within the existing
DB access boundary. Disconnect clears tokens and revokes them upstream where
supported; imported data stays.

Generate a committed endpoint snapshot from
[Epic's directory](https://open.epic.com/MyApps/Endpoints). Let the person select
an organization or enter a FHIR base URL. Discover authorization/token endpoints
from `/.well-known/smart-configuration`, with the CapabilityStatement security
extension as a compatibility fallback. Validate discovered destinations and
pagination URLs before server-side requests or forwarding credentials.

Use the [SMART authorization flow](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html):

1. At Connect, authorize the target profile and bind single-use state and a PKCE
   S256 verifier/challenge to that profile and connection.
2. Request minimal read scopes supported by the endpoint, patient context via
   `launch/patient`, and `offline_access` for background refresh. Request
   `openid fhirUser` when identity claims are needed. Do not request the
   EHR-embedded `launch` scope for this standalone flow. See
   [SMART scopes](https://hl7.org/fhir/smart-app-launch/STU2.2/scopes-and-launch-context.html).
3. Keep the callback session-gated. Consume and compare state safely, recheck
   access to the initiating profile, exchange code plus verifier, and validate
   the response before saving tokens. A changed active profile must not retarget
   the connection. Scope every subsequent query to the authorized patient.
4. Refresh on use before expiry, persisting rotated tokens. Refresh eligibility
   and lifetime depend on the server and consent; `offline_access` is a request,
   not a guarantee. A rejected refresh records failure and offers Reconnect.

## Sync and document persistence

Run a bounded initial pull, then incremental pulls from the shared hourly tick
and **Sync now** action. Maintain progress per connection and resource type.
Choose v1 queries from existing mapper coverage and endpoint capabilities;
`FHIR_IMPORT_RESOURCE_TYPES` in `lib/fhir/bundle.ts` owns parser coverage.
DiagnosticReport mapping already exists, but remote query support and referenced
resource fetching still need endpoint validation.

Follow pagination with page/time limits. On a truncated pull, 429, or 5xx, retain
progress and the last committed data, record the outcome, and resume later;
respect `Retry-After`. Advance a committed cursor only after successful
persistence. Unsupported resource types and malformed records must surface as
coverage gaps, not successful complete-chart imports.

Each connection owns one `medical_documents` row. Persist a **complete retained
snapshot**, not just the current page or incremental response:

- Stage paginated initial results until the selected pull scope is complete.
- Merge changed resources into the retained bundle by `(resourceType, id)`.
  `_lastUpdated` filters changed resources; absence from that response is not
  deletion. Use a validated deletion signal or a completed full reconciliation
  for the same authorized scope before removing retained resources. Scope loss
  or a failed resource query must not erase prior data. See
  [FHIR R4 search](https://hl7.org/fhir/R4/search.html#_lastUpdated).
- Canonicalize the complete snapshot with stable resource ordering and removal
  of nonclinical envelope volatility, preserving clinical content and references.
  Compare its content hash with the committed document; identical content records
  an unchanged sync without replacing rows.
- Send changed snapshots through `persistHealthRecordDoc`, passing the profile,
  document ID, and complete bundle buffer. It replaces that document's rows through
  `persistDocumentImport` and returns `done` or `failed`; inspect that result.
  Coordinate the stored file, hash, and cursor with successful persistence so a
  failure cannot skip data on retry.

The file/progress commit protocol and provider deletion support need validation
before implementation is release-ready. Reprocessing a delta alone would delete
unchanged rows; the existing import helper does not assemble snapshots or commit
sync cursors for callers.

Keep one provenance document per connection and sync history in existing events.
Manual exports remain separate documents, with shared read-layer dedup handling
overlap. Disconnect preserves the document; deleting it removes its imported
records. Honor the shared deletion/tombstone contract when an active connection
loses its document; automatic sync must not recreate data the person removed.

Keep operational logs to counts and outcomes. If raw capture is needed, reuse
`lib/integrations/raw-log.ts` with its bounded local storage; never send clinical
contents to external diagnostics.

## Verification and delivery

Follow the [change and test policy](change-policy.md): extend existing coverage
first, and add cases only for new failures. Use synthetic fixtures and mocked
provider responses in CI. Verify:

- State replay, changed active profile, and unauthorized callbacks cannot attach
  tokens or records to the wrong profile; queries retain patient scope.
- Identical pulls do not replace rows; partial and incremental pulls preserve
  unchanged records; failed persistence retains retryable progress; confirmed
  deletions reconcile within the correct scope.
- Refresh failure is visible in Review, reconnect works, disconnect keeps data,
  and document deletion follows the agreed lifecycle.
- Setup and connection states are usable, including missing public URL/client ID
  and unavailable endpoints. Use browser coverage only for distinct UI risks.

Before release, exercise connect → pull → visible records with provenance in
Epic's sandbox using synthetic patients, then document registration and setup.
Keep this manual external check out of credential-dependent CI. Resolve actual
endpoint scope, refresh, pagination, and deletion behavior there before claiming
production support. Add vendor-specific handling only for demonstrated behavior;
do not prebuild a quirks framework or split delivery into speculative PRs.
