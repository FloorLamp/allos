# Integrations — sync semantics deep-dive

Status: **shipped** · extracted verbatim from AGENTS.md (#597)

Maintainer documentation for `lib/integrations/`: the declarative registry, push
vs pull providers, idempotent ingest, sync-event accounting, the user-edit lock,
and the Data → Review surface — with the full design history and issue trail.
The load-bearing invariants are summarized in AGENTS.md; the user-facing setup
guide is [`integrations.md`](../integrations.md).

---

**Integrations** (`lib/integrations/`) are declarative: `registry.ts` lists
Health Connect, Strava, Oura, Withings, Fitbit Takeout, Weather & UV, and the
outbound `calendar-feed` as available; Garmin is planned. Health Connect is
**push-based** — an authenticated ingest endpoint
(`app/api/integrations/health-connect/ingest/route.ts`) receives POSTs from a
phone exporter on a rolling 48-hour window. Ingest must stay **idempotent**:
dedup on natural keys (time windows) and never overwrite manually entered rows.
Every sync appends an `integration_sync_events` row (`recordSyncEvent` in
`connections.ts`) carrying an insert/update/unchanged split (detected by a
SELECT-before-compare in the `normalize.ts` upserts, since `info.changes` can't
see a no-op UPDATE). **User-edit lock (#133):** imported `activities`,
`body_metrics`, and `medical_records` rows each carry an `edited` flag; the
app's edit paths set it on a source-owned row (`isEditLocked` in `sync-log.ts`),
and the keyed upserts skip an edit-locked row (counting it `unchanged`) so a
hand-correction survives the next rolling-window push. **Bulk corrections
(#1603)** ride the same chokepoint: Data → Review's "Fix a run of data" panel
(`lib/bulk-correction.ts` / `lib/bulk-correction-db.ts`) applies a plan →
preview → apply pass over a date-range × source × field run, sets the edit lock
on every corrected source-owned row (the preview says so plainly), snapshots the
inverse into `deleted_rows` (`kind='bulk-correction'`, 24h undo window), and its
undo restores a row only while its value still equals the correction's result —
clearing `edited` only where that correction set it. `body_metrics` is
DB-keyed on `UNIQUE(profile_id, date, source)` (NULL source exempt —
manual/document rows), so its upsert uses `ON CONFLICT DO UPDATE` like the other
tables. The **Data → Review** tab (`components/ReviewInbox.tsx`; profile-scoped
reads in `lib/queries/integrations.ts`; pure count/window helpers in
`lib/integrations/sync-log.ts`) shows a recent-imports feed ("N new · N changed
· N unchanged") plus any currently-failing provider, and a **badge on the Data
nav entry** (`reviewCount` threaded layout → `SidebarContent` → `Nav`) — it is
Data → Review's own count, so since #1801 it badges that entry rather than a
profile menu that no longer exists.

An uploaded document's row in the "Imports" feed also carries the **extraction
confidence** badge (`· N to check`, #1601): the count of extracted rows the
extractor itself hedged on. The number is the `scrutiny` total
`summarizeExtractionConfidence` already computed and stored on the document's
`import_report`, projected by `getImportLogDocuments` (`json_valid`-guarded, so a
garbled report degrades to no badge instead of failing the feed) and rendered
through the one `feedItemView` shape. It is an ordering hint, never a failure:
the produced-count detail, the failure badge, and the sync-event accounting are
unchanged, and an in-flight or failed document never badges.

**One rendering of sync history (#1212 → #1772).** Per-provider sync history —
the events of `integration_sync_events` with the #674 inserted/updated/unchanged
split — renders in exactly ONE place per stream. #1212 established that rule by
retiring `components/IntegrationDebugPanel.tsx`, the setup pages' "Recent
activity" table, which had already drifted from Review's card (the panel still
showed the legacy flat `Recv/Wrote/Skipped` triple while ConnectedSources showed
the split — the #221 "one question, one computation" disease at the component
layer). #1772 kept the rule and **moved the one place**: a recurring provider's
setup page is its HOME, so it renders the history table itself
(`components/integrations/SyncHistoryTable.tsx`) and Data → Review became an
inbox that links back to it. `components/IntegrationSyncHistoryLink.tsx` now
serves only the ONE-OFF archive importers (Fitbit Takeout, patient portals),
whose entries really do live in Review's chronological Imports feed.

**One state model (#1772).** One provider used to be described by four surfaces
in three visual languages: the Integrations grid card, the setup page's status
card (its own badge, `Last sync: <raw SQLite UTC string> UTC`, and the
`last_sync_summary` JSON echoed as unformatted `key: value` badges — a THIRD
accounting alongside `formatSplitLabel` and the legacy `written` fallback),
`IntegrationSyncHistoryLink`, and Review's Connected-sources card. Same question,
different timestamps, different accountings, different affordances depending on
where you stood. The computation is now `lib/integrations/provider-state.ts`
(pure) over `getIntegrationState` (`lib/queries/integrations.ts`), and every
surface FORMATS its answers:

- **Standing + badge.** `providerStanding` folds connection status, the RECENT RUN
  WINDOW (`STANDING_RUN_WINDOW`, the same depth for every caller), and the #1685
  staleness facts into one closed vocabulary (`healthy` / `partial` /
  `intermittent` / `failing` / `needs-reauth` / `not-connected` /
  `never-synced`); `standingBadge` names and tones it, and
  `components/integrations/StatusBadge.tsx` is the ONE place a tone becomes
  classes (the sibling of `NOTICE_TONE` for tinted blocks). Since #1880 the
  standing is FLAP-AWARE — latest-event-wins is gone. `intermittent` means
  failures in the recent window but no escalation (a calm amber fact);
  `failing` means `FAILING_CONSECUTIVE_RUNS` (3) consecutive failures OR a
  breach of the provider's #1685 staleness threshold, COMPOSED via
  `isSyncStale`, never duplicated. Only `failing` and `needs-reauth` escalate
  (`standingEscalates`): the Data badge (`getImportIssues` /
  `getImportReviewCount`), Review's Needs-attention card, the dashboard hero
  item, and the digest's 🔌 lines all gate on that one predicate, so an
  intermittent source can never increase contact anywhere. The source page
  states the rule visibly (`escalationPolicyLabel`, rendered by
  `SyncHistoryTable` with the provider's own `staleAfterDays`).
- **One accounting, two dialects.** `formatSplitLabel` stays the record-language
  engine and is reached only through `formatSyncChange`, which also owns the CACHE
  dialect: a `public` provider writes cells of a global location-keyed cache, not
  user records, so Weather reads _"Forecast refreshed · 16 readings revised ·
  covers Jul 18 – Aug 7"_ rather than the technically-honest, meaningless "16
  changed · 365 unchanged". The dialect comes from the provider KIND
  (`syncVocabularyForKind`), never a provider id. The raw `last_sync_summary`
  badges are retired.
- **One timestamp treatment.** `components/integrations/SyncTimestamp.tsx` renders
  the absolute local time AND the relative one, both in the login's date/time
  shape (#964/#1020). The setup pages used to print the stored UTC string with a
  " UTC" suffix, and Review showed relative-only labels that could collide.
- **One Sync now.** The four redirecting per-provider form actions
  (`sync{Strava,Oura,Withings,Weather}Action`) are gone; `SyncNowButton` serves
  both the setup page and Review over the `sync*Now` actions, which revalidate the
  surfaces they feed (so no client-side refresh).
- **Deliberate surface roles (#1880 item 2: the alert IS the card).** The setup
  page is the provider's home — shared status header (`IntegrationStatusHeader`),
  controls, and the full history table. On Review, an ESCALATED source renders
  ONCE, fully, inside the "Needs attention" card (`EscalatedSources`): standing
  chip, reason (the recorded failure's error, or the staleness observation for a
  quiet stop), the consequence in user terms (the registry's per-provider
  `stoppedConsequence` through `failureConsequence`), and ALL its actions
  together — nothing below restates it. Connected sources is the calm rest:
  `needsAttention` expands partial / not-connected providers with their reason,
  an `intermittent` one collapses to an amber one-liner stating the honest
  pattern (`intermittentRunsLabel` + `intermittentReassurance`), and healthy
  ones collapse to a line linking home. Review's inbox order is attention →
  duplicates/mislabels → connected sources → imports → tools, with the
  "Fix a run of data" power tool collapsed to one `<details>` line at the bottom
  (a `?fix=` deep-link opens it).

**The Import grid (#1880 items 7–8).** `components/IntegrationsGrid.tsx` renders
each provider's card in one of TWO states matching its two jobs: a card whose
provider is set up (any standing except `not-connected`) is a compact STATUS
card — name, standing chip, ONE fact (`formatSyncOutcome` + relative time for
healthy/partial, "Last success &lt;relative&gt;" for intermittent, the error or
"No data since &lt;date&gt;" for escalated), Manage → — while an unconnected
provider keeps the PITCH (short blurb, a few representative chips, Set up →).
The grid orders by state instead of registry-interleaving: attention first (red
border, Reconnect →), then healthy connected, then an "Available" group for the
pitches, planned cards dimmed last. Both states read the same
`getIntegrationState` standing as Review and the source pages, so the three
surfaces cannot disagree about a provider's health.

**The history table (#1772).** The surviving history surface was still the #208
debug feed — it had inherited primary duty from #1212 without a redesign. It is
now a real table (`SyncHistoryTable`): aligned When / Outcome / What changed /
Window columns; the failure REASON on EVERY failure row (it used to render only
for the latest event, so a historical "Sync failed" row explained nothing and one
success erased even the most recent failure's reason from the UI); the run window
stated ONCE above the table and shown per row only where it departs from the norm
(which is exactly where it carries signal, see #1771); absolute + relative times;
consecutive no-ops collapsed per #137 (`buildHistoryRows`, the same rule the
Imports feed applies); and no nested expanders. Since #1880: the norm is the
LATEST windowed run (`runWindowNorm`), never a majority vote over stale history —
after a day rollover the header agrees with the newest row, and OLDER rows note
their divergence (`windowDivergence`: "covered → 2026-08-08 (before the day
rolled)" for the one-day roll, the full range otherwise), never the reverse. And
consecutive IDENTICAL failures collapse like no-ops do ("Failed ×2" +
`failureRunReason`), so an alternating Failed/Refreshed hour reads as a pattern
instead of a zebra; failures with different reasons never group.

**Per-row provenance drill-in (#1333, #1212 parts 1–2).** The deferred "what
this sync wrote" drill-in now ships. A child table `integration_sync_rows`
(migration 110) records, per sync, WHICH records the keyed upserts persisted:
`event_id` → `integration_sync_events(id) ON DELETE CASCADE` (so retention is
inherited from the #388 sweep — no separate purge), `target_table` (CHECK-pinned
to the four user-meaningful tables — `activities`, `body_metrics`,
`metric_samples`, `medical_records`; `hr_minutes` has no row id and
`activity_routes` drills into its parent activity, both excluded), a polymorphic
`target_id` (no FK — a single REFERENCES can't span tables), and a `disposition`
of `inserted` | `updated` **only**. Unchanged re-sends of the rolling window are
deliberately NOT recorded: an hourly push re-states a 48h window whose rows are
almost all unchanged, so persisting them would explode the store — recording
only the value-changing dispositions is both the minimum #1212 asked for and the
natural volume cap. It's a CHILD table (no own `profile_id`; reaches it via the
event join, the exercise_sets convention), so it's absent from `OWNED_TABLES`
and `deleteProfile` clears it explicitly through its parent before the
owned-tables sweep (which runs with `foreign_keys` OFF). The four keyed upserts
(`normalize.ts`) take an optional `SyncRowSink` and push each persisted
inserted/updated row's id alongside their existing `tallyUpsert` call (no
re-implementation — the observation-substrate guard still holds); the sink is
collected per sync and linked to the event id after `recordSyncEvent` returns it
(now `number | null`), via `recordSyncRows` (best-effort, never throws into
ingest). `getSyncRowProvenance(profileId, eventId)` reads it back —
profile-scoped at both ends (the event join + a `profile_id` filter on every
target lookup) — resolving each row to a human label + a typed `AppRoute` deep
link (`timelineDayHref` for a day, `biomarkerViewHref` for a lab), marking a
since-deleted target as removed. `components/SyncRowsDrilldown.tsx` renders it lazily (on `<details>` open, the
raw-payload-viewer pattern) via the `loadSyncRows` read action.

**The drill-in is gated on provenance actually existing (#1771).** It used to
render for any event with `inserted + updated > 0`, so its legacy empty state
("Record-level detail wasn't captured for this sync.") was PERMANENT for Weather
& UV: weather events carry real split counts (hourly UV cells plus the #1726
daily rows) but `runWeatherSync` records no `integration_sync_rows` — and is
right not to, because it writes cells of the GLOBAL location-keyed forecast cache,
which name no user record (#1212's own scoping decision). An expander that
promises record detail and apologizes 100% of the time reads as broken. The gate
is what the EVENT carries, never a provider hardcode: `eventsWithProvenance`
(`lib/queries/integrations.ts`) does ONE indexed seek per provider over
`integration_sync_rows` — sync-event ids are monotonic, so the rendered set is
bounded below by its oldest id — profile-scoped through the parent event per the
child-table convention. The resolved ids ride on `IntegrationState`, the drill-in
renders only for those, and the apologetic fallback branch is deleted (it is now
unreachable for genuine pre-#1333 legacy events too). The split label stays as the
summary either way.

**Metric sample identity (#1101/#1102).** `metric_samples` keys a provider
record on `(profile_id, metric, source, origin, start_time)`; nullable `origin`
is normalized by the unique index. `end_time` is mutable because Health
Connect's daily exporter sends a cumulative day-so-far snapshot whose end
advances to the push moment. A delayed snapshot with an older end is counted
unchanged and never replaces the newer stored value; distinct bucket starts
still coexist and sum. Health Connect also preserves `metadata.data_origin` (for
example Fitbit or Garmin) inside its one integration source. Additive daily
reads first subtotal by origin and keep the largest origin per `(date, source)`,
then apply the existing cross-source preference, so overlapping device origins
and overlapping providers are each reconciled exactly once. The same origin
choice feeds per-source comparison series and raw sleep sessions/SRI, preventing
those secondary consumers from disagreeing with authoritative totals.
Metric-sample tombstones use the same origin/start identity, so deleting an
in-progress snapshot remains sticky when its next push has a later end.

**Substrate-by-convention helpers (#944).** The observation-shaped tables are
NOT merged (#860 rejected that), but the behaviors every keyed upsert shares are
ONE helper each so a new importer can't re-implement (or forget) one. All three
live in the pure accounting/identity layer and are behavior-pinned unchanged by
the DB-tier sync suites (`sync-diff-accounting.test.ts` et al.), with a
source-scan boundary test (`lib/__tests__/observation-substrate.test.ts`)
failing CI on a hand-rolled copy: (1) the **edit lock** — every upsert consults
the `edited` flag only through `isEditLocked` (`sync-log.ts`, #133), never a raw
`found.edited` truthiness (the pre-#944 activities bug); (2) the **source-dedup
split** — each upsert does its own natural-key SELECT-before-compare (the
compare stays per-table: `rowsEqual` over the compare-cols for the three
overwrite-or-skip tables, a bespoke field compare for
`metric_samples`/`hr_minutes` whose `activity_external_id` COALESCE /
multi-field equality can't be a plain `rowsEqual`), then routes the
classification through the SHARED `classifyUpsert`/`tallyUpsert` (`sync-log.ts`,
\#14), so the insert/update/unchanged split is bumped in exactly one place and
can't drift; (3) **latest-per-group** — the "which reading is current" ordering
(newest `date`, then highest `id`) lives in `lib/latest-per-group.ts`
(`latestByGroup`), the pure twin of the SQL `LATEST_IDS_CTE`, keyed on the
domain's #482 identity function (biomarker rows group by `biomarkerFamily`). The
refactor was behavior-neutral: it moved the branch/ordering into the shared
cores without changing what any importer stores, skips, or counts.

**A re-issued result never overwrites silently (#1404).** `medical_records` rows
are keyed by `external_id`, and `upsertVitals` updates the matched row IN PLACE —
so a lab that re-issues a value (a corrected potassium, an amended differential)
used to replace a number the user had already read, with nothing left to show that
it ever changed. The reading still keeps its id (encounter links, follow-ups, saved
items, dismissal keys and the per-row provenance ledger all point at it), but the
value being replaced is now preserved first, in the SAME transaction, as a
`medical_record_revisions` child row (migration 120) carrying the prior
value/unit/range/flag/status plus what the incoming result called itself. The
decision of what counts as a re-issue is one pure function
(`supersedesReading`, `lib/lab-result-lifecycle.ts`): a changed value, unit or
date, or an incoming `corrected`/`amended` status the stored row didn't already
carry. An idempotent re-send of the rolling window stays `unchanged` and writes
nothing; a re-canonicalization changes how a reading is FILED, not what it said, so
it updates in place with no revision row; and an edit-locked row is still skipped
entirely (there is no overwrite, so there is nothing to preserve). A revision is
provenance, never an observation: it is a CHILD (no `profile_id`, reached through
`record_id`, ON DELETE CASCADE), so it never charts, counts or dedupes, it rides
along with its reading through a document delete/reassign, and the undo registry
restores it with the reading. Sources that state a result status thread it through
`NormVital.result_status`; the deterministic FHIR importer maps
`Observation.status` onto the same four-value vocabulary.

**A deleted DOCUMENT stays deleted (#1776/#1777).** The re-import tombstone
(#507/#508) protects rows a keyed upsert would re-insert; documents needed the
same protection at a different consult point. `deleteMedicalDocument` writes a
tombstone into the SAME `import_tombstones` table under
`target_table = 'medical_documents'`, `natural_key = <content_hash>` — the hash is
already the document's identity (`findDedupTarget`). It is deliberately NOT a
member of `TOMBSTONE_TABLES`: those entries are loaded by the keyed upserts in
`normalize.ts`, while this one is consulted by the acquirer ingest path in
`lib/medical-pipeline.ts`, which refuses a tombstoned offer before any row is
reserved. Migration 134 adds a nullable `label` (the filename at delete time) so
the block can be named in Data → Review, where each entry carries a one-tap
"Allow re-acquisition"; existing tombstone rows stay null and are never
backfilled. A refused offer is counted `suppressed` in the run's sync report —
the same column and the same `formatSplitLabel` rendering the re-import
tombstones already use — and creates NO `medical_documents` row, so an
acquirer's retry is idempotent in the table. Deletion is authoritative only
against automation: a HUMAN upload of the same bytes clears the tombstone and
stores, the manual-wins stance the edit lock already takes, and the upload form
says the document was restored rather than un-blocking it silently. The
inventory endpoint (`GET /api/documents/held`) returns these hashes as `deleted`
beside `held`, which is what lets a client with no local state diff and send
safely; the two lists are disjoint by construction, since a delete removes the
stored row as it writes the tombstone and a reassignment clears the
destination's. There is deliberately **no retention sweep** — a swept tombstone
is a delayed resurrection — and `import_tombstones` is already in
`lib/owned-tables.ts`, so profile deletion cleanup is covered.

**A health record is recognized by its ENTRY IDS, not only its bytes (#1780).** One
person can be reachable through two portal logins — the account holder on one and a
proxy patient on another — with both labels bound to one profile, which is correct
(#1739). Collecting through both yields two archives of the same visits, and the content
hash is structurally incapable of collapsing them: the portal regenerates its container
per request, so the packaging always differs while every clinical document inside is
byte-identical. Both used to upload as `stored`, both extracted, and the profile ended up
with every encounter attested twice. The identifier that already matched is the entry id
— each deterministically imported row carries
`external_id = 'document:<id>|ccda:encounter:…'`, and the per-document namespace was the
only thing preventing the comparison. `lib/clinical-content-key.ts` digests a file's
sorted, de-duplicated, kind-prefixed entry-id set; migration 136 stores it on
`medical_documents.clinical_key`, backfilled for existing documents from the
`external_id`s their rows already carry, and `persistDocumentImport` refreshes it at the
one `'done'` transition from the same `PersistInput` the ingest probe reads. The ingest
path probes it beside `findDedupTarget`, with the same `HELD_PREDICATE` and the same
per-profile scope, inside the same reserve transaction — so an acquirer gets the no-row
`already-imported` refusal (counted `suppressed`, and load-bearing here because a
never-byte-stable container would otherwise land a marker row per collection) and a
person gets the same file-less `'skipped'` marker a byte duplicate lands, naming the
document that holds the records. The match is **exact set equality** with a minimum-id
floor: a dedup decision discards an offer, so a partly overlapping export is stored and
an AI-extracted document (which mints no entry ids) never participates. Data → Review
reads a file-less `'skipped'` row as "duplicate — nothing imported" rather than a bare
"skipped", since the two are not the same event. What is deliberately **not** settled
here: collapsing partly overlapping documents onto shared rows would mean deciding what a
row backed by two documents does on delete, on reprocess and on conflicting values, and
nothing is deleted retroactively — documents that already double-imported keep both
copies.

**A refused duplicate is REMEMBERED, so an acquirer stops re-sending it (#1828).** The
two lists above could not express the `duplicate` outcome: it stores nothing (#1781), so
the refused hash was in neither `held` nor `deleted` and the documented "send what is in
neither list" rule made every acquirer re-offer it on every run, forever — 1.7 MB
re-uploaded and re-parsed per run on the instance that reported it, never converging.
#1786 turned that from an anomaly into an ordinary configuration (one person, two portal
logins, one profile), so the seam became permanent. The fix is a third list, `covered`,
over a small dedicated table (`document_coverage_markers`, migration 138): a
records-duplicate refusal on the ACQUIRER path writes
`(profile_id, content_hash, clinical_key, refused_at)`, idempotent per (profile, hash) and
refreshed on re-offer. **Validity is recomputed at read, never stored** —
`coveredDocumentHashes` asks, per marker, whether the profile still holds a document
carrying that clinical key, using the same alias-aware `heldDocumentPredicate` the ingest
probe uses, and additionally omits a marker whose own bytes have since become held (which
is what keeps the three lists disjoint). So a delete, a reassignment away, or a reprocess
into a different entry set makes the hash leave `covered` on the very next read, with no
invalidation hook, no sweep, and nothing signalled to the client — the same
storage-of-evidence / verdict-at-read shape as canonical flag recomputation. It is
deliberately **not** `import_tombstones`: that records a person's decision and this records
the engine's, and their rules differ in both directions (a human re-upload CLEARS a
tombstone, while a human re-upload of a covered file simply earns the duplicate verdict
again). It is equally deliberately not folded into `held`, which also serves the symmetric
diff a client uses to notice documents IT lost. The marker is written only on the acquirer
path — a person's duplicate still lands the visible `'skipped'` row that IS their feedback
— and it is profile-owned (`lib/owned-tables.ts`), out of the portable export, and
untouched by document delete, reassignment and extracted-count accounting, because it
records an offer that was never stored rather than anything a document import wrote.

**A report says WHAT KIND OF RUN it was, and the answer is one predicate (#1888/#1889).**
`status` (`downloaded` / `nothing-new` / `failed`) says how a run went and stays a closed
three-value enum. Two optional booleans on the sync-report body say what the run WAS, and
both are **absent-means-true**, so every client that has never heard of them keeps its
exact meaning: `contacted` (did this report describe a visit to the portal at all) and
`attended` (was a person at the machine). They exist because the acquirer's standalone
`push` ships records already on disk and still reports — the report is also how bindings
are discovered — and that delivery used to ANSWER an open sync request and RESET the
staleness clock. Nobody had checked the portal and allos believed someone had, which is
the one failure this feature cannot have.

The owner's binding constraint was **one predicate, named, shared**:
`reportCountsAsCheck(report)` (`contacted !== false`) in `lib/acquirer-identity.ts` is the
only place that semantic lives, and both consumers derive from it —
`reportAnswersRequest` (contacted, and either successful or attended) and
`reportAdvancesStalenessClock` (contacted and successful). A pure test pins the consumers
as functions of the one predicate rather than restating their truth tables, so a third
consumer joins the rule instead of inventing a variant.

**Why the flags are decided at ingest and read as columns.** `portal_run_reports` holds
ONE ROW PER LOGIN — the last run it reported — which is what keeps the table bounded
(migration 132). A delivery-only push therefore OVERWRITES the previous genuine run's
stamp, so a read-time `contacted = 1` filter would turn "checked yesterday, pushed today"
into "never checked" and nag one day after a real run: the opposite bug, equally silent.
Migration 144 adds a **sticky check clock** — `checked_at` (the answering signal) and
`checked_ok_at` (the staleness clock) — stamped by `recordPortalRunReport` through those
pure predicates and only ever moving forward. `lib/portal-requests.ts` reads them through
ONE shared SQL fragment (`CHECK_CLOCK_COLS`) embedded by both the `openSyncRequests`
projection and the staleness candidate query, and a pure source-scan test asserts neither
consumer restates the predicate in SQL. Migration 144 backfills the clock from the stamps
the old readers used, so a household upgrading mid-week does not suddenly read as
never-checked.

**What a delivery-only report still stamps.** Everything the documents earned: the
`integration_sync_events` row, the per-identity "Last synced" chips
(`identitySyncStatuses`), Data → Review's feed, the connection stamp, and the integrations
accounting. ONLY the checked-the-portal clock holds still. The over-rotation — making a
push look like nothing happened — would be its own bug, and the DB-tier fixture asserts
both halves in one test.

**The escalation clause.** A failed unattended run answers nothing, and is exactly the
information the person-channel copy wants. `unattended_fail_at` / `unattended_fail_message`
are sticky in the same row (a later delivery push must not erase why the machine gave up)
and cleared by any report that answers. The request's Upcoming/digest line then gains ONE
optional clause on `syncRequestCopy` — #1757's one-formatter rule, not a second formatter:
_"The scheduled run couldn't finish (passkey prompt) — someone needs to go to the
machine."_

**The open-request read endpoint (`GET /api/documents/requests`, #1889).** The original
design deliberately withheld requests from the tool; that line was drawn when a portal run
NEEDED a person, and unattended runs changed the premise rather than the principle. The
endpoint preserves everything the line protected: **slugs only, never an address** (the
shape is fixed by the pure `buildSyncRequestList`, exactly as `buildToolConfig` fixes the
registry's, and it carries no account nickname either), **open and unexpired only**
through the one `isSyncRequestOpen` definition, **no claim state, no acknowledgment, no
push channel**, and the `held` endpoint's bearer auth, rate-limit namespace and write-set
scoping — a request is listed only when its portal login covers a profile that token could
write. Requests still reach a person through Upcoming and the digest, unchanged. **The
poll/run race is harmless and needs no coordination:** a request may be answered by
somebody else between the poll and the run, and then the run's own report closes it as
today while a double collection lands as `covered`/dedup on the upload path — the
idempotence a client already has is the whole protocol.

**`declined` is PER-IDENTITY standing state, not a run field (#1889's owner ruling).** A
run signs in once and collects for every patient a login reaches, so one login covering
three people routinely downloads the account holder's records and is refused the two
proxies ON THE SAME RUN. A run-level flag (or a fourth status) cannot express that — the
run neither failed nor was declined. So the report's `identities` list gained a
per-identity outcome (`["JANE DOE"]` still means "I saw this label";
`[{ patient, outcome }]` adds what the run managed), and allos stores the refusal on
`portal_identities.declined` (migration 144) — the sibling of `ignored`, which is the
existing settled-answer shape. It deliberately does **not** copy migration 131's CHECK:
`ignored` is mutually exclusive with having a profile because an ignored label names
nobody here, while a declined identity IS bound to a real profile whose records the
household wants and the portal will not hand over. It renders once as a quiet note on the
patient row and is **never re-reported as a failure event** — no Data → Review badge, no
notification, because a badge that lights every run forever is how a badge stops being
read. Staleness and post-visit **suppress for that identity only**, through the rule that
already existed rather than a new bypass: a declined identity is not collectable, so it
does not count toward the `mappedPatients` input `isStalenessDue` already gates on, and
the post-visit join simply does not reach it. A person's own **"Request sync"** is
unaffected — the system may reduce contact unilaterally, never overrule a user's action.
The state **clears itself** on the next successful collection for that patient (an
`outcome: "collected"` entry, or plainly a `downloaded` report naming them), so a portal
that starts offering the download again needs nobody to notice. Per-identity outcomes are
writes to profile-owned bindings, so they are scoped to the reporting token's write set —
a caregiver token that may write one member of a shared login cannot change another's
standing state, however harmless the direction of that change looks.

**Weather / UV — keyless pull + a GLOBAL location cache (#1172).** The
Open-Meteo weather/UV provider (`registry.ts` id `weather`, kind `public` — a
keyless pull needing no account/credential, only the profile's home location)
breaks two assumptions the other providers share, deliberately. (1) **No
credential:** there is no token/OAuth config; "connect" is just an enable flag
(`integration_connections` status `connected`, set by `enableWeather`), which
the hourly tick and the Integrations grid read like any other provider. The
adapter is swappable behind the small `WeatherSource` interface
(`lib/integrations/open-meteo.ts` — pure `parseOpenMeteoHourly` + the one
network `openMeteoFetch`, injected into `runWeatherSync` so tests are offline);
the endpoint is chosen by date (`chooseEndpoint`) — the forecast API for
recent/future hours, the free **ERA5 archive** for older ones, which is what
lets a PAST logged activity's UV be **backfilled** (the load-bearing requirement
— the dose crosses past outdoor minutes × the UV that actually occurred, not a
forecast). (2) **The cache is GLOBAL, not profile-owned:** UV at a
coordinate+hour is one physical fact, so `weather_uv_hours` (migration 098)
carries NO `profile_id` and is keyed on `(lat, lng, hour_ts)` — two profiles in
the same city share rows. It is therefore NOT in `lib/owned-tables.ts`, NOT
cleared by `deleteProfile`, and NOT in the portable per-profile export (it is
re-fetchable public data; the PHI-adjacent part is the home location, which
already lives in `profile_settings`). The sync is still idempotent and still
profile-attributed: the upsert (`weather-cache.ts` `upsertUvHours`) does a
SELECT-before-compare and routes the insert/update/unchanged split through the
shared `classifyUpsert`/`tallyUpsert`, and each run appends one
`integration_sync_events` row under the acting profile (the cache has no
manually-entered rows, so the "never overwrite a manual row" invariant is
satisfied by there being none). Since #1614 the `public` kind is admitted to
`RECURRING_SOURCE_KINDS`, so Weather renders as a Connected source in Data →
Review instead of surfacing only under Needs attention when failing; since #1772
that means a one-line healthy row there and the full history on its own setup
page, reported in the CACHE dialect (revised forecast readings, not records). The two-sided **UV-dose model** is ONE pure
computation (`lib/uv-dose.ts` `computeUvDose`, #221) that the read layer
(`lib/queries/weather.ts` `getUvDoseForDay`) feeds after applying the
**degradation ladder** live → clear-sky (`uv_index_clear_sky`, else the
`lib/sun.ts` elevation ceiling) → minutes-only; every surface (the sun-exposure
protocol, the DaylightChip UV badge, the overexposure care finding
`uvOverexposureItems`) formats its result. `sun.ts` stays the offline core and
is never replaced — its #570 offline guarantee is preserved.

**The DAILY half (#1726).** The same provider gained a second grain:
`fetchDaily` pulls the daily aggregates the weather-derived situations,
conditions stamps, and outdoor-viability scan read — max/min temperature, mean
sea-level pressure, precipitation, WMO code, peak UV — MERGED with the keyless
Open-Meteo **air-quality** endpoint (US AQI + per-species pollen, reduced to the
day's peak per FAMILY: tree/grass/weed). They land in `weather_days`
(migration 129), global and location-keyed on `(lat, lng, date)` for exactly the
reasons migration 098 gave for the hourly table, one grain coarser: everything
added is a DAILY figure the provider publishes per day or that only means
anything as a day summary, so widening the hourly table would store each 24×.
Three properties are load-bearing:

- **The two upstream halves fail INDEPENDENTLY.** A weather failure fails the
  daily request (there is nothing left to cache); an air-quality failure returns
  `partial` and the run still SUCCEEDS with temperature/pressure cached — the
  pollen/AQI predicates then simply have no data and stay silent.
- **A partial fetch must never erase a cached reading.** Because a row is
  assembled from two endpoints, `upsertWeatherDays` COALESCEs every column: a
  null in the incoming row leaves the stored value alone and only a real reading
  overwrites, so a re-fetch cannot destroy data it did not ask for. A day whose
  incoming values are all null-or-equal is therefore `unchanged`, not a
  destructive `updated`.
- **One run, one accounting, one WINDOW.** Both halves' insert/update/unchanged
  splits merge into the single `integration_sync_events` row, so the Review feed
  reports the run rather than one of its parts. The daily window reaches
  `WEATHER_FORECAST_DAYS` ahead (the planning surfaces need forecast), while the
  situation predicates are handed a series ending TODAY. Every event a run records
  — the success and BOTH failure paths — stamps `startDate → dailyEnd`, the window
  the run SET OUT to cover (#1771). Stamping an hourly-fetch failure with the
  hourly half's shorter reach made interleaved events of one provider describe two
  different window shapes, and read in Review as if a failure had shrunk the
  coverage target.

**The session-to-weather join — one join, three consumers (#1724/#1728).**
`lib/queries/weather-training.ts` joins a profile's logged cardio/sport sessions to the
cached daily weather of the day each happened on. That ONE result feeds the tolerance
ENVELOPE (what conditions this person actually trains in), the journal-card conditions
STAMP, and — through the #1726 predicates over the same series — the Timeline's
notable-day context. It is DERIVED AT READ TIME and never written onto the activity row:
one source of truth, no backfill problem, and a cache gap renders no stamp rather than a
stale one. Because `weather_days` carries no `profile_id` to join on, the join is done in
TypeScript over two reads (profile-scoped activities, global weather) rather than in SQL —
which is also what keeps the profile-scoping guard satisfied.

**Forecast-ahead planning — one computation, two surfaces (#1724 part 5).** The same
envelope run FORWARD over the cached forecast answers "when this week should the outdoor
session happen?". `getOutdoorPlans` produces the line; the digest's This-week glance and
the calm Upcoming planning item both RENDER it, so they cannot disagree about which day
to name (#221). Gating is deliberately narrow — a behind cardio target, an outdoor
activity to plan, and SCARCE viability (`planningWorthSurfacing`) — because a plan line
every week is filler. Two silences are load-bearing and both are pinned: a week where
every day is viable yields nothing (the quiet-day rule), and a week where NO day is
viable yields nothing either, because there is no session to recommend and escalating
about weather nobody can change is what the attention doctrine forbids. Beyond
`FORECAST_HORIZON_DAYS` the scan truncates and the copy hedges; with no cached forecast
there is no line. **Zero new sends**: the digest line rides the morning message that
already goes out, and the Upcoming item is a page surface, dismissible per (activity,
week start) through the shared bus.

**Chunked ingest (#1064).** The Health Connect write path processes the parsed
batch in bounded per-type ~1,000-record slices, each its own IMMEDIATE `writeTx`
(`lib/integrations/health-connect-ingest.ts`), so the connection is never
blocked longer than one chunk and the byte/record caps (32 MB / 100k,
env-overridable via `HEALTH_CONNECT_MAX_INGEST_BYTES`) can be generous.
Idempotency makes this safe: a mid-batch failure leaves the committed chunks in
place and the next rolling-window push re-covers the rest; the edit-lock and
tombstone pre-image are re-read per chunk, and every chunk's split still folds
into ONE `recordSyncEvent` per push (the #14 accounting is per-push, not
per-chunk). Since #1614 that failure event is honest about what landed:
provenance sinks are chunk-transactional, `HealthConnectWriteError` carries the
committed split, and the route records ONE `ok=0` event with the real counts
plus drillable per-row provenance (mirroring the Fitbit Takeout shape from
#1617) instead of null counts over durable rows.

**Truncated pull runs (#1614).** A Strava/Oura/Withings run cut short by a page
cap or 429 stays `ok=1` (its rows landed and the cursor deliberately does not
advance), but its event carries `details.truncated` plus a standard Review
line — written through the one `truncatedSyncDetails()` shape in
`lib/integrations/sync-details.ts` — and the Connected-sources card badges it
"partial" instead of a clean green success. The marker survives the details
char-budget bounding by construction.

**Silent stop — the staleness signal (#1685).** The two existing "this provider
needs attention" signals are both event-driven, and neither can see a connection
that is recording nothing at all. `isAuthRefreshFailure` (#326) only flips a
connection to `needs_reauth` on a DEFINITIVE auth failure — 429/5xx/timeouts stay
transient on purpose, or a passing cloud hiccup would tear down a healthy
connection — and `currentlyFailingProviders` only fires when a provider's LATEST
recorded event is a failure. A phone exporter the OS stopped running, or a poll
that never gets far enough to log, leaves the connection sitting at `connected`
with a green badge, syncing nothing. The only evidence is negative.

So a connected provider whose **last successful sync** is older than a
per-provider threshold raises the SAME `integration:<id>` attention item, with
its own copy. Since #1880 the breach also COMPOSES into the standing itself:
`providerStanding` calls the same `isSyncStale`, so a quiet stop reads
"Sync failing" on every surface (with the staleness observation as its stated
reason via `IntegrationState.stale`), and a flapping provider whose last success
fell outside the threshold escalates even below the consecutive-failure count. The derivation is pure (`lib/integrations/staleness.ts`) and the
thresholds live beside each provider's other metadata in
`lib/integrations/registry.ts` as `staleAfterDays` (null = exempt: a manual
archive import has no cadence to be late against, a `planned` provider has no
connection, and the calendar feed is outbound). It measures the **sync**, not the
data: every polled provider records an `ok=1` event for each successful poll
including a quiet one (`isQuietSync`), so a week between weigh-ins or a rest week
is not staleness — which is what makes a day threshold safe to state at all.

Three deliberate non-firings: an exempt provider; a provider already carrying a
failing/needs-reauth signal (it is reported ONCE — the reauth item names the
cause, and a staleness line naming the symptom underneath it would be noise); and
a connection that has never synced successfully (the copy is "no data since
&lt;date&gt;", which needs a date, and firing there would flag every
freshly-created connection).

It reaches the surfaces the same way the expired-Health-Connect signal (#607)
does — as a synthetic issue in `getImportIssues` (emitted for an escalated
provider whose latest run SUCCEEDED long ago, i.e. nothing failed on record),
carrying the shared `STALE_SYNC_EVENT_ID` sentinel — so the profile-menu badge,
the Data → Review Needs-attention card, the dashboard hero, the Upcoming page
and the morning digest all read one list and cannot disagree about which sources
are broken. A provider whose latest run is a RECORDED failure contributes that
real event instead (it names a cause) — one row per provider either way. Because the
sentinel is shared across providers it is **not unique per row**: any list
rendering these keys on `(provider, id)`. The signal is self-clearing: one healthy
sync and the derivation stops firing, with no lifecycle of its own.

The copy is deliberately distinct from the reauth wording. A revoked grant needs
the user's consent again, so "Reconnect" is correct; a stale connection may be
perfectly authorized and simply not delivering, so the item states the
observation ("&lt;Provider&gt; sync has stopped · No data since &lt;date&gt;")
and asks the user to check, rather than asserting a cause it has no evidence for.
The Data → Review row makes the same distinction — "sync has stopped" instead of
"sync failed", which would claim a failure that never happened.
