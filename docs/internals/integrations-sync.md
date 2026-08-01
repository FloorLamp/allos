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
hand-correction survives the next rolling-window push. `body_metrics` is
DB-keyed on `UNIQUE(profile_id, date, source)` (NULL source exempt —
manual/document rows), so its upsert uses `ON CONFLICT DO UPDATE` like the other
tables. The **Data → Review** tab (`components/ReviewInbox.tsx`; profile-scoped
reads in `lib/queries/integrations.ts`; pure count/window helpers in
`lib/integrations/sync-log.ts`) shows a recent-imports feed ("N new · N changed
· N unchanged") plus any currently-failing provider, and a **profile-menu
badge** (`reviewCount` threaded layout → `SidebarContent` → `UserMenu`) links to
`/data?section=review`.

An uploaded document's row in the "Imports" feed also carries the **extraction
confidence** badge (`· N to check`, #1601): the count of extracted rows the
extractor itself hedged on. The number is the `scrutiny` total
`summarizeExtractionConfidence` already computed and stored on the document's
`import_report`, projected by `getImportLogDocuments` (`json_valid`-guarded, so a
garbled report degrades to no badge instead of failing the feed) and rendered
through the one `feedItemView` shape. It is an ordering hint, never a failure:
the produced-count detail, the failure badge, and the sync-event accounting are
unchanged, and an in-flight or failed document never badges.

**One rendering of sync history (#1212).** Per-provider sync history — the
latest-state card + expandable recent history over `integration_sync_events`,
with the #674 inserted/updated/unchanged split (`formatSplitLabel`) — renders in
exactly ONE place: **Data → Review → "Connected sources"**
(`components/ConnectedSources.tsx`). The provider **setup pages**
(`app/(app)/integrations/{strava,health-connect,oura,withings,weather}/page.tsx`)
used to render a SECOND copy — the "Recent activity" table in
`components/IntegrationDebugPanel.tsx` — over the same rows, and the two had
already drifted (the debug panel still showed the legacy flat
`Recv/Wrote/Skipped` triple while ConnectedSources showed the split). That was
the #221 "one question, one computation" disease at the component layer, so
`IntegrationDebugPanel` was **retired**: each setup page now renders
`components/IntegrationSyncHistoryLink.tsx` — a last-success line plus a LINK to
the single Connected-sources history — never a second copy (the
responsive/shared-content rule, one level up). The link is a real destination,
not a dead-end CTA (#1219).

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
since-deleted target as removed. `components/SyncRowsDrilldown.tsx` renders it
lazily (on `<details>` open, the raw-payload-viewer pattern) under each
Connected-sources event that wrote rows, via the `loadSyncRows` read action.

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
Review — latest state plus expandable history, no Sync-now button, a link back
to its own settings — instead of surfacing only under Needs attention when
failing. The two-sided **UV-dose model** is ONE pure
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
- **One run, one accounting.** Both halves' insert/update/unchanged splits merge
  into the single `integration_sync_events` row, so the Review feed reports the
  run rather than one of its parts. The daily window reaches
  `WEATHER_FORECAST_DAYS` ahead (the planning surfaces need forecast), while the
  situation predicates are handed a series ending TODAY.

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
its own copy. The derivation is pure (`lib/integrations/staleness.ts`) and the
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
does — as a synthetic issue folded into `getImportIssues`, carrying the shared
`STALE_SYNC_EVENT_ID` sentinel — so the profile-menu badge, the Data → Review
Issues list, the dashboard hero, the Upcoming page and the morning digest all
read one list and cannot disagree about which sources are broken. Because the
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
