# Integrations — sync semantics deep-dive

Status: **shipped** · extracted verbatim from AGENTS.md (#597)

Maintainer documentation for `lib/integrations/`: the declarative registry, push vs pull providers, idempotent ingest, sync-event accounting, the user-edit lock, and the Data → Review surface — with the full design history and issue trail. The load-bearing invariants are summarized in AGENTS.md; the user-facing setup guide is [`integrations.md`](integrations.md).

---

**Integrations** (`lib/integrations/`) are declarative: `registry.ts` lists providers (Health Connect, Strava, Oura, and Withings available, plus an outbound `calendar-feed` `.ics` subscription; Garmin planned). Health Connect is **push-based** — an authenticated ingest endpoint (`app/api/integrations/health-connect/ingest/route.ts`) receives POSTs from a phone exporter on a rolling 48-hour window. Ingest must stay **idempotent**: dedup on natural keys (time windows) and never overwrite manually entered rows. Every sync appends an `integration_sync_events` row (`recordSyncEvent` in `connections.ts`) carrying an insert/update/unchanged split (detected by a SELECT-before-compare in the `normalize.ts` upserts, since `info.changes` can't see a no-op UPDATE). **User-edit lock (#133):** imported `activities`, `body_metrics`, and `medical_records` rows each carry an `edited` flag; the app's edit paths set it on a source-owned row (`isEditLocked` in `sync-log.ts`), and the keyed upserts skip an edit-locked row (counting it `unchanged`) so a hand-correction survives the next rolling-window push. `body_metrics` is DB-keyed on `UNIQUE(profile_id, date, source)` (NULL source exempt — manual/document rows), so its upsert uses `ON CONFLICT DO UPDATE` like the other tables. The **Data → Review** tab (`components/ReviewInbox.tsx`; profile-scoped reads in `lib/queries/integrations.ts`; pure count/window helpers in `lib/integrations/sync-log.ts`) shows a recent-imports feed ("N new · N changed · N unchanged") plus any currently-failing provider, and a **profile-menu badge** (`reviewCount` threaded layout → `SidebarContent` → `UserMenu`) links to `/data?section=review`.

**One rendering of sync history (#1212).** Per-provider sync history — the latest-state card + expandable recent history over `integration_sync_events`, with the #674 inserted/updated/unchanged split (`formatSplitLabel`) — renders in exactly ONE place: **Data → Review → "Connected sources"** (`components/ConnectedSources.tsx`). The provider **setup pages** (`app/(app)/integrations/{strava,health-connect,oura,withings,weather}/page.tsx`) used to render a SECOND copy — the "Recent activity" table in `components/IntegrationDebugPanel.tsx` — over the same rows, and the two had already drifted (the debug panel still showed the legacy flat `Recv/Wrote/Skipped` triple while ConnectedSources showed the split). That was the #221 "one question, one computation" disease at the component layer, so `IntegrationDebugPanel` was **retired**: each setup page now renders `components/IntegrationSyncHistoryLink.tsx` — a last-success line plus a LINK to the single Connected-sources history — never a second copy (the responsive/shared-content rule, one level up). The link is a real destination, not a dead-end CTA (#1219). The full drill-in from a sync to the exact rows it wrote (issue #1212 parts 1–2: an `integration_sync_rows` provenance table + per-row deep-links) is deliberately **out** of this dedup pass — it needs a migration and is tracked separately.

**Metric sample identity (#1101/#1102).** `metric_samples` keys a provider record on `(profile_id, metric, source, origin, start_time)`; nullable `origin` is normalized by the unique index. `end_time` is mutable because Health Connect's daily exporter sends a cumulative day-so-far snapshot whose end advances to the push moment. A delayed snapshot with an older end is counted unchanged and never replaces the newer stored value; distinct bucket starts still coexist and sum. Health Connect also preserves `metadata.data_origin` (for example Fitbit or Garmin) inside its one integration source. Additive daily reads first subtotal by origin and keep the largest origin per `(date, source)`, then apply the existing cross-source preference, so overlapping device origins and overlapping providers are each reconciled exactly once. The same origin choice feeds per-source comparison series and raw sleep sessions/SRI, preventing those secondary consumers from disagreeing with authoritative totals. Metric-sample tombstones use the same origin/start identity, so deleting an in-progress snapshot remains sticky when its next push has a later end.

**Substrate-by-convention helpers (#944).** The observation-shaped tables are NOT merged (#860 rejected that), but the behaviors every keyed upsert shares are ONE helper each so a new importer can't re-implement (or forget) one. All three live in the pure accounting/identity layer and are behavior-pinned unchanged by the DB-tier sync suites (`sync-diff-accounting.test.ts` et al.), with a source-scan boundary test (`lib/__tests__/observation-substrate.test.ts`) failing CI on a hand-rolled copy: (1) the **edit lock** — every upsert consults the `edited` flag only through `isEditLocked` (`sync-log.ts`, #133), never a raw `found.edited` truthiness (the pre-#944 activities bug); (2) the **source-dedup split** — each upsert does its own natural-key SELECT-before-compare (the compare stays per-table: `rowsEqual` over the compare-cols for the three overwrite-or-skip tables, a bespoke field compare for `metric_samples`/`hr_minutes` whose `activity_external_id` COALESCE / multi-field equality can't be a plain `rowsEqual`), then routes the classification through the SHARED `classifyUpsert`/`tallyUpsert` (`sync-log.ts`, #14), so the insert/update/unchanged split is bumped in exactly one place and can't drift; (3) **latest-per-group** — the "which reading is current" ordering (newest `date`, then highest `id`) lives in `lib/latest-per-group.ts` (`latestByGroup`), the pure twin of the SQL `LATEST_IDS_CTE`, keyed on the domain's #482 identity function (biomarker rows group by `biomarkerFamily`). The refactor was behavior-neutral: it moved the branch/ordering into the shared cores without changing what any importer stores, skips, or counts.

**Weather / UV — keyless pull + a GLOBAL location cache (#1172).** The Open-Meteo
weather/UV provider (`registry.ts` id `weather`, kind `public` — a keyless pull needing
no account/credential, only the profile's home location) breaks two assumptions the
other providers share, deliberately. (1) **No credential:** there is no token/OAuth
config; "connect" is just an enable flag (`integration_connections` status `connected`,
set by `enableWeather`), which the hourly tick and the Integrations grid read like any
other provider. The adapter is swappable behind the small `WeatherSource` interface
(`lib/integrations/open-meteo.ts` — pure `parseOpenMeteoHourly` + the one network
`openMeteoFetch`, injected into `runWeatherSync` so tests are offline); the endpoint is
chosen by date (`chooseEndpoint`) — the forecast API for recent/future hours, the free
**ERA5 archive** for older ones, which is what lets a PAST logged activity's UV be
**backfilled** (the load-bearing requirement — the dose crosses past outdoor minutes ×
the UV that actually occurred, not a forecast). (2) **The cache is GLOBAL, not
profile-owned:** UV at a coordinate+hour is one physical fact, so `weather_uv_hours`
(migration 098) carries NO `profile_id` and is keyed on `(lat, lng, hour_ts)` — two
profiles in the same city share rows. It is therefore NOT in `lib/owned-tables.ts`, NOT
cleared by `deleteProfile`, and NOT in the portable per-profile export (it is
re-fetchable public data; the PHI-adjacent part is the home location, which already lives
in `profile_settings`). The sync is still idempotent and still profile-attributed: the
upsert (`weather-cache.ts` `upsertUvHours`) does a SELECT-before-compare and routes the
insert/update/unchanged split through the shared `classifyUpsert`/`tallyUpsert`, and each
run appends one `integration_sync_events` row under the acting profile (the cache has no
manually-entered rows, so the "never overwrite a manual row" invariant is satisfied by
there being none). The two-sided **UV-dose model** is ONE pure computation
(`lib/uv-dose.ts` `computeUvDose`, #221) that the read layer (`lib/queries/weather.ts`
`getUvDoseForDay`) feeds after applying the **degradation ladder** live → clear-sky
(`uv_index_clear_sky`, else the `lib/sun.ts` elevation ceiling) → minutes-only; every
surface (the sun-exposure protocol, the DaylightChip UV badge, the overexposure care
finding `uvOverexposureItems`) formats its result. `sun.ts` stays the offline core and is
never replaced — its #570 offline guarantee is preserved.

**Chunked ingest (#1064).** The Health Connect write path processes the parsed batch in bounded per-type ~1,000-record slices, each its own IMMEDIATE `writeTx` (`lib/integrations/health-connect-ingest.ts`), so the connection is never blocked longer than one chunk and the byte/record caps (32 MB / 100k, env-overridable via `HEALTH_CONNECT_MAX_INGEST_BYTES`) can be generous. Idempotency makes this safe: a mid-batch failure leaves the committed chunks in place and the next rolling-window push re-covers the rest; the edit-lock and tombstone pre-image are re-read per chunk, and every chunk's split still folds into ONE `recordSyncEvent` per push (the #14 accounting is per-push, not per-chunk).
