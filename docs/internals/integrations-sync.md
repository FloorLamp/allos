# Integrations — sync semantics deep-dive

Status: **shipped** · extracted verbatim from AGENTS.md (#597)

Maintainer documentation for `lib/integrations/`: the declarative registry, push
vs pull providers, idempotent ingest, sync-event accounting, the user-edit lock,
and the Data → Review surface — with the full design history and issue trail.
The load-bearing invariants are summarized in AGENTS.md; the user-facing setup
guide is [`integrations.md`](../integrations.md).

---

## Vocabulary: `sourceId` in TypeScript, `provider` in SQL (#2487)

`Provider` and `provider_id` are reserved for **healthcare** clinicians and
organizations (the `providers` table). A connected integration — Strava, Oura,
Health Connect and friends — is a **source**, named `sourceId` in every
TypeScript parameter, field, and query API, matching the user-facing "Connected
sources" wording.

The **persisted columns still say `provider`** on `integration_connections`,
`integration_sync_events`, `integration_backfill_jobs` and `stream_frontiers`.
That rename is deliberately deferred to its own forward migration, so phase 1
leaves a named boundary rather than a hidden one: reads select
`provider AS source_id` explicitly, writes bind the TS value into the old
column, and every such statement carries a short `#2487 boundary` comment. Row
shapes therefore expose `source_id` (snake case, mirroring the aliased result
column); everything else — parameters, locals, derived types — uses `sourceId`.
There is no wrapper type and no adapter layer; the alias is the mapping.

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
inverse into `deleted_rows` (`kind='bulk-correction'`, its own 24h undo window —
excluded from Data → Trash, which lists deleted ROWS, not inverted edits), and its
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

**A second clock is a second chance to be wrong (#2011).** Natural-key dedup only
catches a row a provider sends twice; the duplicate that survives it is one
SESSION reported by two providers under two `external_id`s, which is what
`lib/import-review/detect.ts` looks for and Data → Review offers. Overlapping
clock windows are the HIGH signal there, and non-overlap used to be the end of the
story on the cross-source path — "two timed sessions at different times of day are
genuinely distinct". That is true of one person's day and false of two providers'
claims ABOUT that day: a source sending the right instant against the wrong UTC
offset (a non-DST `utc_offset`, a DST boundary, a third-party push into the
provider) lands its copy a whole hour off, the windows miss by minutes, and the
duplicate splits into two activities that double the day's distance, cardio
minutes, and effort. The duration/distance proximity check could not save it: it
is the fallback for MISSING times, unreachable once both rows have one.

So the cross-source path carries a narrow rescue below the overlap check —
non-overlapping windows, an OFFSET-SHAPED start gap of 30 to 120 minutes
(`clockOffsetMinutes`, bounded by `MIN_CLOCK_OFFSET_MIN`/`MAX_CLOCK_OFFSET_MIN`),
and proximity agreement on BOTH duration and distance (`proximityComparisons === 2`;
one measure is too weak to carry a pair whose clocks already disagree).
Offset-shaped means a whole number of hours plus one of `CLOCK_OFFSET_MINUTE_PARTS`
— because the world's UTC offsets are not all whole hours (#2063): India +5:30,
Newfoundland -3:30, Nepal +5:45, Chatham +12:45. The original guard admitted only
integer hours and so rejected exactly those households' duplicates. The quarter
hour is the one documented exclusion: reachable in principle (Chatham read as
+13:00) but also the grid people schedule on, so it would cost more safety margin
than it buys. That shape requirement is the entire safety margin: two genuinely
distinct back-to-back sessions do not begin an exact UTC offset apart, an offset
copy of one session does exactly. The result is MEDIUM and says so — "clocks differ
by 1h", "clocks differ by 30m" —
because `autoMergeCluster` still demands genuinely overlapping windows, so nothing
merges itself on this evidence; the pair waits for a person. Nothing about this is
Strava-specific and none of it belongs in a parser: any provider can report a bad
offset, and the parser is right to read the local time it was handed. The
SAME-source path gets no rescue at all — one source is one clock, so its two rows
cannot disagree about the offset, and an hour between them is an hour of the
person's actual day.

**The offset question belongs to INGEST, and now has ONE owner (#2088).** Everything
above describes a DETECTOR forgiving a provider's wrong clock — and that is how the
family kept producing issues: #2011/#2055 taught the detector whole hours,
#2063/#2092 taught it the fractional offsets the world actually uses, and #2056
found that the same gap across midnight files the two copies under different
profile-local dates, where the detector's date bucket could not reach them. Three
symptoms of one question, answered in three places.

`lib/clock-skew.ts` is that one place. It owns the plausible-offset table
(`PLAUSIBLE_OFFSET_MINUTE_PARTS` + the 30–120 minute bounds), the continuous-clock
arithmetic that measures two dated readings from ONE midnight, and
`canonicalizeProviderClock`. `lib/import-review/detect.ts` consumes it — its
historical `CLOCK_OFFSET_MINUTE_PARTS` / `MIN_`/`MAX_CLOCK_OFFSET_MIN` /
`clockOffsetMinutes` / `formatClockOffset` names remain, now as the primitive's
answers rather than a second copy of them.

Canonicalization has **two branches, and the difference between them is evidence**:

- **A true INSTANT needs none.** Strava's `start_date_local` is
  `start_date + utc_offset`, and that offset is a property of the athlete's account
  as Strava understood it — stale after a move, wrong across a DST boundary, wrong
  again when a third party pushed the activity in. That is precisely how #2011's
  duplicate arrived an hour early. `start_date` is a true instant, so given the
  profile's own timezone the local day and clock follow with nothing inferred:
  `lib/integrations/strava.ts` takes that answer at ingest, so the row lands where it
  belongs the FIRST time instead of being rescued later. Idempotent (an
  already-canonical row reports `changed: false`, and the shared upsert then counts
  it unchanged) and edit-lock-respecting (`isEditLocked` skips a hand-corrected row
  before any of this).
- **A bare WALL CLOCK needs cross-source evidence, and still names no liar.** With no
  evidence the primitive refuses (`no-evidence`) and the row is left exactly as
  reported — never a speculative shift on a lone row. With evidence it reports a
  `skew`: the disagreement and its size, and nothing about which provider was wrong,
  because #2055 already ruled that nothing in a pair of wall clocks says so. That
  verdict is what the cross-source rescue renders in Data → Review.

**A wrong offset can move the DATE too (#2056).** A pair the loaders never load is a
pair nothing can canonicalize, and the loaders group by calendar date — the SQL
pre-filter in `loadActivityDupRows`, its `SELECT *` twin in
`lib/import-review/auto-merge.ts`, and the pure bucketing in
`findActivityDuplicates`. So the CANDIDATE phase reaches one day either side, by the
primitive's own window: consecutive dates, the earlier row at or after
`EVENING_CANDIDATE_CLOCK` (22:00) and the later at or before
`MORNING_CANDIDATE_CLOCK` (02:00), both derived from `MAX_PLAUSIBLE_OFFSET_MIN` so
the candidate set can never reach further than the classifier would forgive.
`activityWindowFrom` then measures both windows from one midnight, so a 23:30/00:30
pair reads as the one-hour gap it is rather than a 23-hour one. Nothing else changes:
cross-source only (one source is one clock), the same offset SHAPE, the
same both-measures proximity, and the same MEDIUM verdict — `autoMergeCluster`
measures overlap on each row's own clock, which two rows an offset apart never have,
so a cross-midnight cluster always waits for a person. The two loaders share the
widening rather than copying it (`lib/import-review/candidate-sql.ts`), because a
pre-filter that drifted between Data → Review and the unattended auto-merge would let
them see different worlds. A cross-midnight cluster is named by the day the session
STARTED.

**An INFERRED type is not a blocking key (#2271).** The candidate phase used to
require the two rows to AGREE about what the session was — both loaders bucketed on
`(date, type)`, the adjacent-day widening carried `AND l.type = e.type`, and
`findActivityDuplicates` gated cross-source pairs on `a.type === b.type`. The value
doing that blocking was frequently not a claim any provider made: Health Connect sends
`EXERCISE_TYPE_OTHER_WORKOUT` ("a workout, unspecified") for a gym session and the
parser answered that stated absence with `sport`, while Strava mapped the same word
"workout" to `strength`. Two providers that did not disagree, rendered as a
disagreement, blocking a pair whose clock windows overlapped almost exactly — one
60-minute session read as two workouts and 120 minutes, with nothing in Review.

So the type requirement moved out of CANDIDACY and into the PROXIMITY branches alone.
Both loaders and the shared adjacent-day SQL now bucket on `date`; a pre-filter may
only ever be a SUPERSET of what the pure classifier accepts. Inside
`classifyCrossSourcePair`, the overlap branch asks nothing about type — overlapping
clock windows already mean one session, which is why the SAME-source path has always
treated overlap alone as HIGH with no type check, and why `autoMergeCluster` never
looked at type at all — while the clock-skew and the duration/distance branches keep
it, because that is where the gate's own argument lives ("without a type check this
would start pairing a 30-minute run with a 30-minute swim"). The adjacent-day loop
keeps its own gate for the same reason: two rows an offset apart never overlap, so it
rests on proximity agreement and nothing else. No backfill was needed —
`loadFullCandidateRows` selects by profile, not by recency, so the next sync's
auto-merge pass re-evaluates the whole history.

**A merge destroys the identity a SEND was keyed on (#2570).** `writeActivityFold`
carries a dropped row's data onto the keeper — sets, routes, telemetry, laps, segment
efforts, videos, tombstones, pair decisions, provenance. It did not carry the one fact
about a dropped row that is not data and cannot be recovered from it: **that the user
was already told about this session.** The post-workout nudge is one-shot per activity
**id**, and `autoMergeKeeperId` prefers the richer sourced row, so a provider syncing
LAST wins the keeper slot as a row that did not exist a moment ago and carries no
marker. One bike ride mirrored into Health Connect by three apps — one of them twice,
32 seconds apart — produced three notifications in one afternoon, the third of them
CAUSED by the merge.

`writeActivityFold` now calls `carryPostWorkoutMarker`
(`lib/notifications/post-workout-marker.ts`, a leaf module so a merge never imports
the notification stack) before the caller's delete, so the survivor inherits the
announcement. Undo deliberately does NOT reverse it: `revertActivityMerge` restores a
drop under a NEW id with no marker of its own, so reversing could only cause a second
send for a session already announced, and the contact-consent rule permits reducing
contact unilaterally, never increasing it. The dropped rows' markers are left as inert
orphans — an id never recycles, so they can never suppress another session.

The same-source half of that defect is NOT fixed here and is not a merge change at
all: `autoMergeCluster`'s cross-source gate declines every same-source group by design
and stays as it is, so the dispatch grew its own duplicate awareness instead. See
`docs/internals/notifications.md`.

**Which clock survives the merge is the person's call, not a guess (#2011).** The
fold rule already settles it mechanically: the keeper's own `start_time`/`end_time`
win outright and the discarded row only ever fills a GAP, so keeping the
correctly-offset copy leaves the bad hour behind. Deliberately NOT added: a rule
inferring which provider lied. Nothing in the pair says which of two assertions is
false, a heuristic there would be the system asserting knowledge it does not have,
and it would fight `preferActivityKeeper`'s documented order. What the pair DOES
know — that the clocks disagree, and by how much — is named in the reason string,
and the Review card renders both windows, so the choice is informed rather than
automated. `start_time`/`end_time` stay out of `CONFLICT_FIELDS` (the picker is for
numeric magnitudes); the keeper radio is the seam.

An uploaded document's row in the "Imports" feed also carries the **extraction
confidence** badge (`· N to check`, #1601): the count of extracted rows the
extractor itself hedged on. The number is the `scrutiny` total
`summarizeExtractionConfidence` already computed and stored on the document's
`import_report`, projected by `getImportLogDocuments` (`json_valid`-guarded, so a
garbled report degrades to no badge instead of failing the feed) and rendered
through the one `feedItemView` shape. It is an ordering hint, never a failure:
the produced-count detail, the failure badge, and the sync-event accounting are
unchanged, and an in-flight or failed document never badges.

**Strava cycling detail.** The pull requests `profile:read_all` alongside
`activity:read_all`. Strava's default read allowance is application-wide — 100
requests per 15 minutes and 1,000 per UTC day — so every list, detail, athlete,
zone, and stream request passes through one process-wide budget keyed by client
id. The budget reserves short-window and daily headroom and learns upgraded app
limits and current usage from Strava's `X-ReadRateLimit-*` response headers. A
quiet trailing-window poll is list-only for cycling artifacts already stored;
athlete settings and keyed streams are fetched only for a ride whose streams are
missing. The absolute per-operation request cap remains a second safety bound and
advances the existing cursor over successive runs. DetailedActivity's
embedded laps and segment efforts cost no extra request. The normalized grouping
preserves cycling subtype: MountainBikeRide is Mountain
Biking, while VirtualRide and `trainer: true` rides are Stationary Bike so the
indoor-only Analyze capability policy applies without inferring from absent GPS.
`activity_telemetry` stores the compact keyed stream JSON plus the FTP and zone snapshot in one
profile-owned row per activity/source; `activity_laps` and
`activity_segment_efforts` store the individually rendered children. All three
are idempotent and activity-cascaded, are included in profile deletion, undo,
and portable export, and remain optional for older tokens: a profile-scope 403
does not block activity/stream import, while reconnecting grants FTP/zones.
Trailing rescans preserve the last good stream, lap, segment, FTP, and zone data
when an independent supplemental request fails. FTP and zones are immutable once
captured for a ride (a reconnect may fill a previously missing snapshot), so a
later athlete-setting change cannot rewrite historical training load. Activity
merges re-parent these children before deleting a duplicate, and undoable merges
move them back with the restored activity.

Each telemetry row also carries `stream_summary_json`, computed at ingest: the
power-curve bests and the per-zone seconds, which are the only two things the
cycling overview derives from a ride's streams. Before it existed, that page
parsed every stream blob the profile owned on each load, so its cost grew with
total ride history in bytes parsed rather than rows returned. Both values are pure
functions of the telemetry row's own `streams_json` and `power_zones_json` and of
nothing on the activity row — which is why one computation at ingest stays correct
for the life of the row, and why re-parenting or restoring a row cannot invalidate
it. A writer other than the Strava upsert must either write the summary through
`summarizeCyclingStreams` or leave the column NULL. The summary is stamped with a
signature naming the rule that produced it (the logic version plus the durations
the curve was taken at), and the `reconcileCyclingStreamSummaries` boot task
re-derives any row whose stamp does not match the current rule — the same
"derived state can go stale without a schema change" reasoning the canonical-flag
reconcile is a boot task for. That pass is also the backfill: migration 175 adds
the column empty. A summary that is missing or stale is treated as absent, never
as a reason to fall back to parsing the streams. The overview's power cards
therefore stay ALL-TIME, unlike its heart-rate distribution, which is windowed —
see `docs/features.md` and `lib/cycling-stream-summary.ts` for why those two reads
on one page answer differently on purpose.

The connected Strava page exposes **Backfill ride details** for cycling
activities imported before telemetry existed (or whose prior stream request
failed). This runs through the provider-neutral durable backfill substrate:
`IntegrationDef.backfills` declares stable metadata; executable bindings live in
`backfill-runners.ts`; and `integration_backfill_jobs` checkpoints total,
completed, failed, provider requests, active processing time, retry time, and error.
The same progress component renders live on the provider page and from the shared
integration state in Data → Review. ETA is observed throughput over active work,
plus any known provider-quota wait — pause time never pollutes the throughput rate.

Each completed ride is written atomically and disappears from the missing-row query,
so the job is idempotent without a second provider cursor. A quota pause records the
natural Strava reset boundary; the hourly integration pass resumes due jobs, while
boot recovery turns an abandoned queued/running lease into a resumable pause. The
browser may navigate away: progress is DB-backed and read through the scoped
`/api/jobs/integration-backfills` observer, not held in a Server Action response.
Power curves, FTP-relative load, and same-route identity are derived at read
time rather than stored as competing facts. The aligned `time` and `latlng`
streams remain optional but, when present, drive the ride detail's chart-linked
route marker without making a map or geocoding request.

**A candidate the source can never answer for (#2196).** Not every candidate leaves
the missing-row query by succeeding. A deleted or now-private activity answers
404/403 forever and stores nothing; an indoor or manually-entered ride answers 200
with no telemetry at all and stores an empty `streams_json` the same predicate
matches again. Both used to hold the job in `failed` permanently — `remaining` never
reached zero — while the progress line said "N retrying" about a success that was
never coming, and the second class is invisible to any rule keyed on HTTP status.

So `remaining` means **still worth asking about**, not "still missing". A run
classifies each candidate it attempts through `backfillFetchVerdict`
(`lib/integrations/backfill-outcome.ts`, which owns the HTTP half — 403/404/410 are
final, everything else including 400, 401 and a network throw stays retryable) plus
the runner's own "fetched fine, carries no payload" half, and subtracts the final
ones from `remaining`. The job then reaches `completed`, which is also what stops the
automatic re-attempt: a completed job is not due.

No give-up marker is stored, deliberately. The verdict is recomputed from the
source's answer on every run, so a ride made public again, a token re-authorized with
`activity:read_all`, or an upload Strava has since processed is picked up by the next
retry — and a wrong verdict is wrong for one run rather than for the life of the row.
The cost is two requests per unavailable candidate, spent only when a person retries.
`failed_items` holds both counts because the STATUS already separates them: a
retryable failure keeps `remaining > 0` and so keeps the job `failed`, which is why
`backfillFailureLabel` reads a completed job's leftovers as "N unavailable" and
everything else as "N retrying" without a second column.

**A re-queue resumes, it does not restart (#2195).** `paused` and `failed` are both
"stopped part-way, imported rows intact", so both preserve `total_items`,
`completed_items`, `request_count`, `active_seconds` and `started_at` on the next
manual queue — the earlier run's throughput is what the ETA is computed from, and
zeroing it made a job that was 60 rides in read "0 of 40". The counters are re-derived
on every queue rather than carried forward, so a candidate set that has changed since
cannot leave the bar describing work that no longer exists. `completed` is not
resumable: nothing stopped part-way, so a fresh queue over newly-imported rides starts
at 0 of N.

**A resume credits exactly what it will not ask about again (#2672).** That
re-derivation used to be `completed + missing`, floored at the prior total — and
`completed_items` credits the unavailable candidates above, which the candidate query
still returns, so the two terms counted the same rows twice. A job holding one
permanently-unavailable ride and one retryably-failing ride grew its own denominator
on every attempt: "1 of 3", then "2 of 4", then "3 of 5", for two rides, with the
percentage moving backwards each time and no convergence. The rule that replaces it
lives in `lib/integrations/backfill-counters.ts` (pure, unit-tested): a resumed job
carries only the items that have LEFT the candidate query, because those are the ones
it will never re-ask — an unavailable one IS re-asked, which is exactly what the
missing give-up marker buys. `carried` has no column of its own, but the prior
`total_items` IS `carried + candidates` while the candidate set has not moved, so
`total = max(candidates, prior total)` and `completed = total - candidates` are exact
in that case and conservative — understated, never inflated — when new candidates have
arrived since. The accounting was the whole defect: a run still asks about each
candidate exactly once, and the request spend per retry never moved.

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
serves only the ATTENDED providers (Fitbit Takeout, patient portals — the
`KIND_DELIVERY` family, #2301), whose entries really do live in Review's
chronological Imports feed.

**The DELIVERY axis (#2301): who moves the data.** The state model below is one
vocabulary of connection verdicts, and four of the nine registered providers have
no connection at all. `lib/integrations/delivery.ts` declares the axis that was
always implied:

```ts
export type IntegrationDelivery = "scheduled" | "attended" | "outbound";
export const KIND_DELIVERY: Record<IntegrationKind, IntegrationDelivery> = {
  push: "scheduled",
  oauth: "scheduled",
  token: "scheduled",
  public: "scheduled",
  archive: "attended",
  "external-attended": "attended",
  feed: "outbound",
};
```

- **`scheduled`** — data moves without a person present: allos polls, or the source
  pushes on its own schedule. **The only family for which "is the connection
  working?" is a question.**
- **`attended`** — a person must act for anything to arrive. Allos cannot start it,
  cannot retry it, and may never call it late.
- **`outbound`** — allos publishes; nothing arrives, and no runs are recorded.

**Derived from the KIND, never declared per provider**, because the kind already
encodes it and two providers of one kind cannot differ — a per-provider field would
be a second source of truth for a fact the kind already states. The
`Record<IntegrationKind, …>` IS the enforcement: a new kind is a build error until it
declares its delivery, the same idiom as `FAMILIES: Record<ReconcileFamily, …>`.

It replaced four hand-rolled subsets, each a different one:

| Retired                                                        | Was                                                                                                                                                                                   | Now                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECURRING_SOURCE_KINDS` (`lib/queries/integrations.ts`)       | a `Set<string>` naming 4 of the 7 kinds; `public` was once missing, which left Weather's successful history unreachable while its failures still showed under Needs attention (#1614) | `isScheduledKind(kind)`                                                                                                                                                                         |
| `WHERE provider = 'fitbit-takeout'` (`lib/queries/imports.ts`) | the two-member attended family enumerated in SQL by naming ONE member                                                                                                                 | a bound `IN (…)` over `integrationsWithDelivery("attended")`                                                                                                                                    |
| `syncVocabularyForKind(kind: string)`                          | untyped, so `archive`/`external-attended` fell into the polled dialect with no exhaustiveness to fail                                                                                 | `kind: IntegrationKind`, exhaustive switch (same VALUES — the typing is the guard)                                                                                                              |
| `syncRunNounForKind(kind: string)`                             | two `if`s and a default `"sync"`                                                                                                                                                      | `kind: IntegrationKind` → `SyncRunNoun \| null`, with `"import"` (archive), `"upload"` (external-attended) and **`null` for `feed`** — a noun for a run is a fiction where no runs are recorded |

`pluralRunNoun` became a declared `Record<SyncRunNoun, string>` at the same time: its
`${noun}es` suffix rule was right for exactly the three nouns that existed and yields
"importes"/"uploades" for the two added.

**Three standing families, one union, one consumer table each (#2301).** Verified on
a prod snapshot: Fitbit Takeout rendered **"Connected", green** for a ten-day-old file
import; the calendar feed rendered **"Connected" plus a permanent "No syncs yet"**
because nothing will ever sync in; patient portals rendered **"Intermittent"**, a
flapping-CONNECTION word for a hand-run tool whose silence tolerance is `null`, making
the standing's own contract vacuous. `standingBadge` returned `tone: "good"` for
`healthy` and `never-synced`, and _good_ is a health verdict — the one claim allos
cannot make about a source it does not drive.

```ts
type ScheduledStanding =
  | "healthy"
  | "partial"
  | "intermittent"
  | "failing"
  | "needs-reauth"
  | "not-connected"
  | "never-synced";
type AttendedStanding =
  "imported" | "attempt-failed" | "never-imported" | "not-set-up";
type OutboundStanding = "feed-enabled" | "feed-off";
```

`providerStanding()` takes the delivery and dispatches to one private derivation per
family, each returning its own subtype — **the producer is where illegal combinations
become unrepresentable**, so no future code path can hand an attended provider
`failing`. The seven-state derivation moved into the `scheduled` branch verbatim: the
#2263 silence rule, `intermittent`, and the flap window are untouched for the providers
they were written for, and no scheduled verdict moved.

The attended vocabulary was **promoted, not invented**. Two surfaces had already opted
out of the shared model rather than be described wrongly by it, and both had
hand-rolled the honest words — the Fitbit page's `Last import ${when}.` /
"Set up, but nothing imported yet." / "No archive imported yet.", and `lib/portal-status.ts`
("this integration is attended, so a quiet login is a login nobody has run yet, not a
broken one"). `attempt-failed` is the state both lacked; before this a failed Takeout
import read `intermittent`.

| State            | When                         | Badge                         | Tone        | Headline                         |
| ---------------- | ---------------------------- | ----------------------------- | ----------- | -------------------------------- |
| `imported`       | last attempt succeeded       | "Last import" / "Last upload" | **neutral** | "Imported" / "Uploaded" (+ when) |
| `attempt-failed` | last recorded attempt failed | "Last import failed"          | caution     | "The last import failed"         |
| `never-imported` | set up, nothing in yet       | "Nothing imported yet"        | neutral     | "Set up — nothing imported yet"  |
| `not-set-up`     | no connection, no history    | "Not set up"                  | neutral     | "Not set up"                     |
| `feed-enabled`   | outbound feed live           | "Feed enabled"                | neutral     | "Publishing to your calendar"    |
| `feed-off`       | outbound feed disabled       | "Feed off"                    | neutral     | "Feed off"                       |

- **Tone is never `good` outside the scheduled family.** Green asserts health; for a
  source allos does not drive the honest statement is only _when_ something last
  arrived, and the reader decides whether that is fine.
- **No `needs-reauth` for attended.** A revoked upload token surfaces as a failed
  attempt, which is what the user sees and acts on. Fewer states, same information.
- **`not-set-up` rather than `not-connected`**, because "Not connected" frames a file
  import as a link you failed to make.
- **`attempt-failed` is an attention item and never an escalation.** It joins
  `partial` and `not-connected` in `needsAttention` — expanded in Review, no badge, no
  digest 🔌 line. `standingEscalates` stays exactly `failing || needs-reauth`, both
  scheduled-only, so **no attended or outbound state can ever escalate**. That is the
  property that makes the split worth doing rather than three more members on a flat
  union: only the user knows whether they will run the tool again, and a digest line
  about a portal tool last touched on someone's laptop is the crying-wolf failure
  #1880 exists to prevent.
- **Nothing about runs renders for an outbound provider.** `StatusFact` returns null
  and the status header suppresses "No syncs yet" — that string is a promise a sync is
  coming, and the calendar card had been making it permanently since it shipped.
- **`escalationPolicyLabel` gained the attended inverse.** It returned `null` for an
  exempt provider (honest silence); an attended page now states the positive instead —
  _"This source is only ever as fresh as your last import — allos never marks it late,
  because only you can start it."_ Outbound stays silent. Two callers render it:
  `SyncHistoryTable`, above the history on every scheduled provider page, and the
  **Fitbit Takeout** Status card, which has no history table and so had no surface for
  the one thing an attended source's owner needs to know. Both source it the same way
  — tolerance, run noun, and delivery all DERIVED FROM THE KIND, never asserted at the
  call site.
- **A card's body copy speaks its badge's dialect.** `StatusFact`'s `attempt-failed`
  fallback is `standingHeadline(standing, syncRunNounForKind(kind))` — the function
  that already writes that sentence in either dialect. It used to be the hardcoded
  literal "The last import failed", so a patient-portals run that failed carrying no
  error string read _import_ directly under a badge reading _Last upload failed_.
- **`standingUnconfigured`** answers "was this ever set up at all" across all three
  families (`not-connected` / `not-set-up` / `feed-off`), so the Import grid's
  status-card-vs-pitch-card decision is one rule rather than a member list.

**The Imports feed reads the FAMILY, not the provider (#2301).** `getImportDocumentsFeed`
merges documents, paste/CSV jobs and every **attended** provider's runs — a bound
`IN (…)` built from `integrationsWithDelivery("attended")`. Before this it named
`fitbit-takeout` alone, so patient-portals' recorded runs, failures included, appeared
on **no** Review surface at all: Connected sources excludes the kind, this feed
excluded the provider, and `getImportIssues` cannot reach it (an attended provider is
exempt from the silence rule, so it can never be `failing`).

**Still scoped out, decided rather than deferred.** `silenceToleranceMinutes` stays a
nullable field on `IntegrationDef` rather than becoming part of a delivery-discriminated
union — `null` = exempt already reads correctly and is covered by #2263's completeness
test. `PortalStatusTone` is not merged into `StatusTone`: portal rows are per-**login**
and deliberately profile-less, a different grain about a different subject. And the two
attended pages keep their hand-rolled status this round; adopting `IntegrationStatusHeader`
there is a follow-up whose whole value is that it no longer lies.

**One state model (#1772).** One provider used to be described by four surfaces
in three visual languages: the Integrations grid card, the setup page's status
card (its own badge, `Last sync: <raw SQLite UTC string> UTC`, and the
`last_sync_summary` JSON echoed as unformatted `key: value` badges — a THIRD
accounting alongside `formatSplitLabel` and the legacy `written` fallback),
`IntegrationSyncHistoryLink`, and Review's Connected-sources card. Same question,
different timestamps, different accountings, different affordances depending on
where you stood. The computation is now `lib/integrations/source-state.ts`
(pure) over `getIntegrationState` (`lib/queries/integrations.ts`), and every
surface FORMATS its answers:

- **Standing + badge.** `providerStanding` folds connection status, the RECENT RUN
  WINDOW (`STANDING_RUN_WINDOW`, the same depth for every caller), and the #1685
  freshness facts into one closed vocabulary (`healthy` / `partial` /
  `intermittent` / `failing` / `needs-reauth` / `not-connected` /
  `never-synced`); `standingBadge` names and tones it, and
  `components/integrations/StatusBadge.tsx` is the ONE place a tone becomes
  classes (the sibling of `NOTICE_TONE` for tinted blocks). Since #1880 the
  standing is FLAP-AWARE — latest-event-wins is gone — and since #2263 the
  escalation is ONE rule: `failing` means **no successful run inside the
  provider's silence tolerance**, COMPOSED via `isSyncStale`, never duplicated.
  `intermittent` means failures in the recent window with a success still inside
  that tolerance (a calm amber fact), which now includes a provider failing every
  run while its data keeps landing. Only `failing` and `needs-reauth` escalate
  (`standingEscalates`): the Data badge (`getImportIssues` /
  `getImportReviewCount`), Review's Needs-attention card, the dashboard hero
  item, and the digest's 🔌 lines all gate on that one predicate, so an
  intermittent source can never increase contact anywhere. The amber surfaces state
  the honest failure tally AND the observed success cadence beside it
  (`observedSuccessCadenceMinutes` / `successCadenceLabel`, #2263 item 4) —
  measured for DISPLAY only, never feeding the declared tolerance. Since #1913 the digest
  gives a broken source exactly ONE entry — the named 🔌 line IS its band item, not
  a sibling of a count — and the line's cause fragment comes from the item's
  declared `because`, never from the card sentence its `detail` was written for. The source page
  states the rule visibly (`escalationPolicyLabel`, rendered by
  `SyncHistoryTable` with the provider's own resolved tolerance; null, and so
  rendered as nothing, for an exempt provider).
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
  both the setup page and Review, and since #2040 it calls ONE generic
  `syncNow(id)` (`app/(app)/integrations/sync-actions.ts`) rather than four
  `sync*Now` actions with an identical skeleton. The action revalidates the
  surfaces the run feeds (so no client-side refresh) from the registry's
  `pull.revalidates`.
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

**History groups by DAY (#1991).** #1772 made the history a real table but left it a
per-RUN log, and a per-run log is the wrong shape for a source that fires ~70×/day:
the Health Connect exporter re-sends its rolling window every ~20 minutes, so the
table read "Synced · N new · 4 changed · 73 unchanged" seventy times over. The
repeating "73 unchanged" is the tell — it is not news, and a real anomaly was
invisible in that stream. `lib/integrations/sync-history-days.ts` (pure) is the rule:

- **A day is one line** — `26 pushes · 340 new · 12 changed`, plus an attention chip
  when the day contains one (`syncDayAttention`, worst-first: failures outrank a
  cut-short run, which outranks dropped rows). The day is the READER'S: `syncEventDay`
  resolves the profile's local date, because a UTC slice puts a 21:00 push on the
  wrong side of midnight for anyone east or west of Greenwich. The run NOUN comes
  from the provider kind (`syncRunNounForKind`), the same derivation the vocabulary
  uses — a phone exporter pushes, a keyless cache refreshes.
- **Opening a day itemizes only what earned it**: anything that failed, was cut short,
  or skipped rows, plus the NEWEST run (that is what you came to check). Everything
  else collapses to a range — `7 syncs · routine · 128 new` — with "Show each →".
  This is #137's no-op collapsing generalized from _nothing happened_ to _nothing
  NOTABLE happened_, and it is frequency-agnostic: Health Connect collapses
  dramatically, an hourly source turns 24 rows into a line plus its anomalies, and a
  once-a-week import renders one line either way. No per-provider variants.
- **The newest day opens by default.** It is the common visit; collapsing it would
  make every check two taps.
- **The WINDOW column is gone.** It was structurally constant per provider (an entire
  column of em-dashes for Health Connect) and is already stated once above the list.
- **The raw payload is one admin-only link per run, opening a dialog**
  (`components/RawPayloadDialog.tsx`). The inline `<details>` version rendered Expand
  all / Collapse all / Copy / Download plus a scrolling object tree INSIDE a history
  row — an admin debugging tool in the primary reading position, pushing the actual
  history below the fold. Same capability, same gate, no longer the centrepiece.
  `RawPayloadViewer` (inline) stays where it IS the content: Review's inbox card and
  the Imports feed each show one event with nothing beneath it to bury.

`SyncHistoryTable` is now a PROJECTOR: it turns SQLite rows into plain serializable
views so the interactive list (`SyncHistoryDays`, a client component) can own the
"Show each" state without a row proxy crossing the boundary.

**The status card answers and stops (#1991 pin 9).** On the provider's own page the
status card and the first history row carried the identical split, the same
"What this wrote", and the same "View raw" — the #1772/#1880 duplication, now inside a
single screen. `IntegrationStatusHeader` takes a `detail` projection:
`"period"` (the source page) states the standing as a sentence
(`standingHeadline`) plus TODAY'S aggregate (`periodActivityLabel` — "26 pushes today,
340 records added, 12 updated", and null rather than a lie when the newest recorded
day is not today), and nothing about the newest run; `"run"` (Review's inbox card)
keeps the newest run's split, coverage, drill-in and raw link, because that card shows
ONE event with nothing beneath it — that IS its content. Same component, same shape,
one per-surface choice, exactly like the existing `controls` slot.

**And the source pages are CENTRED (#1991 item 6, #1880 item 5).** Every
`app/(app)/integrations/*` page now wraps its whole content — back link, header, cards
— in ONE `<PageContainer width="reading" className="mx-auto">`; the inner containers
became plain grids. `mx-auto` alone passes through `className` by design (the page
WIDTH still comes from the named token), so `lib/__tests__/page-width-scan.test.ts`
stays satisfied.

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
and the schema-derived profile-delete sweep (`lib/profile-delete.ts`, #2126)
clears it through its parent before the owned-tables loop (which runs with
`foreign_keys` OFF). The four keyed upserts
(`normalize.ts`) take an optional `SyncRowSink` and push each persisted
inserted/updated row's id alongside their existing `tallyUpsert` call (no
re-implementation — the observation-substrate guard still holds); the sink is
collected per sync and linked to the event id after `recordSyncEvent` returns it
(now `number | null`), via `recordSyncRows` (best-effort, never throws into
ingest). `getSyncRowProvenance(profileId, eventId)` reads it back —
profile-scoped at both ends (the event join + a `profile_id` filter on every
target lookup) — resolving each row to a human label + a typed `AppRoute` deep
link (`timelineDayHref` for a day, `readingDetailHref` for a medical record —
which resolves a continuous vital to its metric detail page and every episodic
reading to `/results/readings/view`, #1932), marking a
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
is what the EVENT carries, never a provider hardcode: `provenanceCountsByEvent`
(`lib/queries/integrations.ts`) does ONE indexed, grouped seek per provider over
`integration_sync_rows` — sync-event ids are monotonic, so the rendered set is
bounded below by its oldest id — profile-scoped through the parent event per the
child-table convention. The resolved counts ride on `IntegrationState`
(`provenanceCounts`), the drill-in renders only for events that have some, and the
apologetic fallback branch is deleted (it is now unreachable for genuine pre-#1333
legacy events too).

**…and it COUNTS what it can show (#1991 defect 1).** The label used to be the split
total while the list was `integration_sync_rows`. Since the sink deliberately skips
minute-grain targets with no row id, a Health Connect push rendered
"What this wrote (30)" and expanded to three rows: overstating by 10× while looking
complete — worse than #1771's empty case, which at least announced itself.
`drilldownCoverage(written, itemizable)` (`lib/integrations/sync-history-days.ts`) is
the one rule, with three outcomes decided from DATA rather than a provider list:
everything written → itemize all; partial → itemize what it can and name the
remainder ("+27 more this run wrote — not itemizable (no per-record link)"); nothing
→ no drill-in at all. The remainder is deliberately NOT named by KIND: the provenance
table is what knows which rows they were, and it does not record them — inferring
"heart-rate samples" from a subtraction would be the system asserting knowledge it
does not have. The bulk still counts in the run's split; it stops pretending to be
openable. `SyncRowsDrilldown` also re-labels itself from the LOADED rows once open,
so the promise and the list can never disagree in front of the reader.

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

**A stored sleep session is an ABSOLUTE INSTANT (#2096).** `start_time` is both
the natural upsert key and the value every read path hands to `new Date()`, and
ECMAScript resolves an offset-less date-time in the PROCESS zone — so a boundary
stored as bare wall clock denotes a moment that is a property of the container's
`TZ` rather than of the data. The Fitbit Takeout parser stored the vendor's
zoneless `startTime`/`endTime` verbatim; on one profile's 52 nights that moved
the derived typical wake time by four hours between the profile's zone and
`TZ=UTC` (what Docker ships), and moved the night count too, as sessions
re-bucketed across the wake-day boundary. It stayed hidden because
`readSleepSessions` pins the whole read to ONE elected source, so the zoneless
rows sat inert on any profile whose newest sleep came from elsewhere.
`parseSleepJson` now takes `tz` and resolves each boundary through
`zonedWallIsoToUtc` (`lib/date.ts`) — the seconds-and-millis, refuses-rather-than-
guesses sibling of `zonedWallTimeToUtc`. The wake DAY still comes from Fitbit's
own `dateOfSleep`, which was never zone-derived. `lib/__tests__/sleep-session-instants.test.ts`
holds the invariant across all four sleep-emitting parsers, because a reader
cannot repair a stamp that arrived without a zone. Migration 155 reinterprets the
rows already stored — skipping edit-locked ones, and moving the delete tombstones
with them so a re-import cannot resurrect a deleted night under the new key.
This is a SIBLING of the clock-skew canonicalization (#2088), not the same
mechanism: that one repairs an absolute timestamp carrying a wrong plausible
offset, inferred from cross-source duplicate evidence; here nothing is wrong by
an offset, the offset is simply absent, and the profile's zone is the answer.

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
Migration 146 adds a **sticky check clock** — `checked_at` (the answering signal) and
`checked_ok_at` (the staleness clock) — stamped by `recordPortalRunReport` through those
pure predicates and only ever moving forward. `lib/portal-requests.ts` reads them through
ONE shared SQL fragment (`CHECK_CLOCK_COLS`) embedded by both the `openSyncRequests`
projection and the staleness candidate query, and a pure source-scan test asserts neither
consumer restates the predicate in SQL. Migration 146 backfills the clock from the stamps
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
machine."_ In the digest that clause becomes the line's `because` fragment, since it
is why it is the person's turn.

**The digest's portal line (#1913 items 5–8).** `🙋 Run the portal tool for tbh — never
checked · expires in 6 days`. The glyph says **who acts** — 🔌 is "a connection broke and
allos will keep retrying", 🙋 is an errand only a person can run, away from the device
reading the message, which is the whole premise of #1757. The cause is
`syncRequestCopy`'s `because` fragment (the card's `detail` restates the title and would
have said the imperative twice), and the **expiry rides the line** because it is the only
deadline the ask has — carried on `DigestSyncIssue.dueText`, and null for an integration,
which has no expiry at all. `DOMAIN_NOUN["portal-sync"]` ("portal check") is never
rendered now that the merge landed.

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
`portal_identities.declined` (migration 146) — the sibling of `ignored`, which is the
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
that starts offering the download again needs nobody to notice. Every write to `declined`
— the stated outcome and the plain `downloaded` self-clear alike — is a write to a
profile-owned binding, so **both** intersect the reporting token's write set _inside the
`lib/portals.ts` core_ (`applyIdentityOutcomes`, `clearIdentityDeclined`): a caregiver
token that may write one member of a shared login cannot change another's standing state,
however harmless the direction of that change looks. The intersection lives in the core
rather than at the call site because the self-clear used to be safe only by CALL ORDER,
and was in fact running before the route's own write gate — a token refused with `403`
had already cleared the flag on the profile it was refused at (#1960). Ordering is not a
property a function can enforce for its callers.

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
satisfied by there being none). Since #1614 the `public` kind counts as a
recurring source — declared since #2301 as `KIND_DELIVERY.public === "scheduled"`,
which retired the hand-written `RECURRING_SOURCE_KINDS` set that had omitted it — so
Weather renders as a Connected source in Data →
Review instead of surfacing only under Needs attention when failing; since #1772
that means a one-line healthy row there and the full history on its own setup
page, reported in the CACHE dialect (revised forecast readings, not records). The two-sided **UV-dose model** is ONE pure
computation (`lib/uv-dose.ts` `computeUvDose`, #221) that the read layer
(`lib/queries/weather.ts` `getUvDoseForDay`) feeds after applying the
**degradation ladder** live → clear-sky (`uv_index_clear_sky`, else the
`lib/sun.ts` elevation ceiling) → minutes-only; every surface (the sun-exposure
protocol, the DaylightChip UV badge, the overexposure care finding
`uvOverexposureItems`) formats its result. `sun.ts` stays the offline core and
is never replaced — its #570 offline guarantee is preserved. A surface asking about
MANY days (the Timeline's per-day chip) calls `getUvDoseForDays` (#2113), which
resolves home location / timezone / skin type once and widens both the activities and
the cached-UV reads over the whole date set; `getUvDoseForDay` is its one-date adapter,
so both run the same per-day assembly and cannot drift.

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
ENVELOPE (what conditions this person actually trains in), the training-log-card conditions
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

**One pull-sync runner (#2040).** The per-provider pull stack used to duplicate at
three layers, and the files said so themselves — `withings-sync.ts` opened with
"Mirrors oura-sync.ts", `oura-sync.ts` with "Mirrors strava-sync.ts". Each module
declared its own `TIMEOUT_MS` / `MAX_PAGES` / `RESCAN_DAYS` /
`INITIAL_BACKFILL_DAYS`, implemented its own `fetchPages()` with the same 429 →
truncate-and-keep-cursor rule, and ended in its own ~60-line `writeTx` → cursor →
`recordSync`/`recordSyncEvent`/`recordSyncRows` tail; four `sync*Now` actions shared
one skeleton; and the notify tick fanned out four copy-pasted
`try { if (connected) … } catch {}` blocks. The cause was structural — `registry.ts`
had a `kind` facet but no way to say "this is a provider we pull", so every layer
above it enumerated providers by hand, and Garmin would have been a fifth copy of
all three.

- **The facet.** `IntegrationDef.pull` (`lib/types/integrations.ts`) declares
  `revalidates` — the surfaces a completed run feeds, typed
  `readonly RevalidateTarget[]` so the compiler checks each one exactly like an
  in-`app/` `revalidateRoute` target (#2149) — plus an OPTIONAL `paging` block (`timeoutMs`, `maxPages`, `rescanDays`,
  `backfillDays`) for a credentialed paged pull. Weather declares no `paging`: it
  is keyless with no cursor and no pagination, and inventing numbers to make the
  shape uniform is exactly the "forcing a non-OAuth provider into the facet" the
  issue ruled out. `pullPaging(id)` THROWS for a provider that declares none,
  because a module silently reading `undefined` for `maxPages` would sync nothing
  forever. `PULL_INTEGRATIONS` excludes `planned` entries — Garmin's card is real,
  its runner is not.
- **The pure half.** `lib/integrations/pull-window.ts` owns the rate-limit rule
  (429, plus a provider's own dialect — Withings' envelope `601`), the page cap,
  the day/second re-scan window arithmetic, and the two CURSOR POLICIES.
  `hold-on-truncate` (Oura, Withings) holds a window-edge cursor when a run is cut
  short, or the days past the re-scan margin would be stranded forever;
  `advance-to-processed` (Strava) advances anyway, because that cursor names the
  newest activity actually IMPORTED and holding it would re-pay every per-activity
  detail call the truncated run already spent. One rule, pinned once.
- **The runner.** `lib/integrations/pull-sync.ts` `runPullSync(profileId, spec)`
  owns credentials (a `null` token is "not connected" and logs nothing; a THROW is
  a recorded failure), the needs_reauth flip on a definitive auth status, the one
  `writeTx` over the shared `normalize.ts` upserts, the post-commit hooks, the
  cursor decision, and the whole `recordSync` / `recordSyncEvent` / `recordSyncRows`
  accounting including the `truncated` marker. A provider's `PullSpec` supplies
  only what is genuinely its own: how to authorize, how to page (`next_token` vs
  `offset`/`more` vs `page`), how to map rows, and what to call its counts.
- **The layers above.** `lib/integrations/pull-runners.ts` binds `run` + the
  outcome sentence per id — kept OUT of `registry.ts`, which the pure tier and
  client components import and which must not drag `@/lib/db` behind it. It
  throws at startup for a facet with no runner bound. `syncNow(id)` and the tick
  both iterate it; `getIntegrationState`'s `canSyncNow` is now `isPullIntegration`
  rather than a hand-kept id set.

Behaviour is identical per provider — the existing DB suites
(`sync-orchestrators`, `oura-sync`, `withings-sync`) pass unedited, and
`lib/__db_tests__/pull-runner.test.ts` adds the property they cannot show: two
providers through the one runner, each with its own rows, counts, events and
cursor shape, idempotent on a second pass, and one failing without touching the
other.

**Poll cadence is declared, not implied by the scheduler (#2121 step 1).** The
notify tick used to conflate two different cadences: _how often it evaluates what
is due to send_ (bounded only by the tick process's ~0.5 s boot) and _how often it
calls someone else's API_ (bounded by that provider's quota). Because the pull pass
ran unconditionally at the top of every profile's tick, the second was silently
pinned to the first — measured in #2121, a 1-minute tick would have meant ~1,440
Strava calls per profile per day, at or over typical app quotas. That is what made
the tick rate a quota decision rather than a scheduling one.

- **Where it is declared.** `pull.cadenceMinutes` in `registry.ts`, beside the
  provider's other delivery metadata, for the same reason
  `silenceToleranceMinutes` lives there: the right number is a property of the provider's quota, not of the
  scheduler. All four pull providers declare `60` today — hourly, exactly what
  they were polled at before — each with its own reasoning. A provider that
  declares none gets `DEFAULT_PULL_CADENCE_MINUTES` (60), so a new provider joins
  at the cadence the quota table was measured against and must opt IN to anything
  finer. Read it only through `pullCadenceMinutes()`.
- **How it is enforced.** `lib/integrations/pull-cadence.ts` is the pure decision;
  `lib/integrations/pull-tick.ts` is the tick's pull pass (moved out of
  `scripts/notify.ts` so the loop that decides how many external calls an instance
  makes is testable at all). A provider is polled at most once per epoch-aligned
  window of `cadenceMinutes` — buckets, not "minutes since the last poll", because
  elapsed-since needs a slack tolerance that an hourly cron would trip over
  (09:00:01 → 10:00:00 measures 59m59s) and that then drifts the effective cadence
  earlier at fine tick rates.
- **No new state.** The last-run fact was already recorded: every run appends an
  `integration_sync_events` row, indexed on `(profile_id, provider, at)` and swept
  by the #388 retention pass. The guard reads it. It keys on the last ATTEMPT, not
  the last SUCCESS — a failed poll spent an API call, and "the remote is failing"
  is the worst case in which to retry on every tick.
- **Manual "Sync now" is not cadence-guarded.** It goes through
  `app/(app)/integrations/sync-actions.ts` straight to the runner. The system may
  reduce its own contact unilaterally; it does not overrule a user's own action,
  and "I just connected this, sync it" is why anyone presses that button. Strava
  requests still pass through the application-wide read budget, so a manual sync
  cannot spend past the provider allowance shared with other profiles.
- **The seam for what comes next.** A pull-based Health Connect ingest (#1563) and
  Garmin (#1863) join the polled set through the same dial and should declare
  cadence and quota posture in their scoping, rather than inheriting whatever the
  scheduler happens to be set to.

`lib/__tests__/pull-cadence.test.ts` asserts the quota bound as a bound — it
simulates a day of ticks at 1/15/60-minute rates and counts the polls admitted —
and `lib/__db_tests__/tick-repetition.test.ts` drives the real pass with stubbed
provider hosts: two ticks in one window make one round of outbound calls and write
one event row per provider.

**The window has a PHASE now, because :00:00 is a bad minute to call anyone
(#2567).** Weather & UV lost **209 of 289 runs (72.3%)** in twelve days, every one
of them `weather fetch failed (503)`. Not a bad request, not the network, not
Open-Meteo being down — **when** the poll fires. Buckets are epoch-aligned, so an
hourly source fires on the first tick of each hour, at `:00:00`, with no jitter
anywhere in the loop. Probing that exact instant from the affected host returned
503s at T+0s — rejected in ~0.40 s against a 15 s timeout, a load shedder answering
before doing work — and 5/5 clean at T+10s and every later offset. The stored ledger
carries the same signature: failures stamped 01–03 seconds past the hour, successes
02–08. **Strava is the control**: same container, same egress, same epoch-aligned
bucket, same instant, 348 runs at `:00` and zero failures.

So `pullWindow` takes an `offsetMinutes` that **shifts the window BOUNDARY**, and
`pullDecision` resolves one per `(install, profile, source)` — hashed, never random,
because a moving offset is a moving boundary and an untestable one. The install
ingredient is `install_first_boot_at` (an existing global settings key, no new
setting and no migration), and it is the part that matters most: without it every
allos in the world would still hash profile 1 + weather to the same minute, and the
herd being shed is exactly what the offset exists to leave.

Shifting the boundary rather than _declining the window's first N ticks_ is the
whole safety argument. Declining ticks is unsafe at coarse tick rates: an operator
running an hourly tick at `:00` against a 60-minute cadence would decline every tick
it ever gets and the source would never poll again. `floor((t − offset) / cadence)`
is still a fixed-length bucket turning over once per cadence — the once-per-window
bound, the absence of drift and the absence of any tolerance to tune are all
untouched — and it degrades to today's behaviour at an hourly tick while giving the
intended stagger at the 5-minute tick the sidecar ships. The offset is clamped to
`[5, cadence − 5]` so the shifted edge is never within one shipped tick of `:00`.

**Retry on 5xx was proposed and declined.** The probe's own evidence (70/70 off-peak,
5/5 at T+10s) says jitter is the fix and a retry is hygiene; with the boundary moved
it answers nothing measured, doubles the outbound calls a keyless free API sees during
a genuine outage, and would make a real outage look like a flap in a ledger that
records one event per run. If it is wanted later it has to be recorded, which is its
own change.

**Truncated pull runs (#1614).** A Strava/Oura/Withings run cut short by a page
cap or 429 stays `ok=1` (its rows landed and the cursor deliberately does not
advance), but its event carries `details.truncated` plus a standard Review
line — written through the one `truncatedSyncDetails()` shape in
`lib/integrations/sync-details.ts` — and the Connected-sources card badges it
"partial" instead of a clean green success. The marker survives the details
char-budget bounding by construction.

**A half-failed weather run recorded as a clean success (#2567).** `runWeatherSync`
computes `partial` when the daily/air-quality half fails, folds it into the returned
summary and logs it — and then wrote its `integration_sync_events` row WITHOUT it:
`ok: true`, no details, no error, nothing anywhere saying the run was degraded. The
only trace was `received` dropping from 381 (360 hourly + 21 daily) to 360, which is
how two silently-degraded runs among eighty were eventually found. Nothing was
missing but the write: `isTruncatedSyncEvent` already reads the marker,
`scheduledStanding` already returns `"partial"` off it, and three sources already
share the serializer. It writes it now, through that same shape, with its own Review
line: `truncatedSyncDetails()` takes an optional warning so weather can name the half
that failed instead of claiming a page cap or a rate limit it never hit. The durable
marker is identical either way.

**Silence is the whole escalation rule (#1685, unified in #2263).** The two
event-driven "this provider needs attention" signals cannot see a connection that
is recording nothing at all. `isAuthRefreshFailure` (#326) only flips a connection
to `needs_reauth` on a DEFINITIVE auth failure — 429/5xx/timeouts stay transient on
purpose, or a passing cloud hiccup would tear down a healthy connection — and
`currentlyFailingProviders` only fires when a provider's LATEST recorded event is a
failure. A phone exporter the OS stopped running, or a poll that never gets far
enough to log, leaves the connection sitting at `connected` with a green badge,
syncing nothing. The only evidence is negative.

So THE rule, asked once:

> A connected provider escalates when **no successful run has landed within its
> tolerance** — whether the silence was recorded as failures, recorded as nothing,
> or a mix.

That collapses two rules that were answering the same question at two incompatible
grains. #1880's escalation counted CONSECUTIVE FAILED RUNS (three), which is not a
measure of whether data is arriving: for an hourly provider three runs is three
hours, and Weather & UV's own p90 gap between successes is six — so the threshold
sat below the provider's ordinary operating variance and it read "Sync failing" for
**29% of hours** across 171 measured runs while every success re-fetched its full
381-row window. #1685's quiet-stop rule was at whole-DAY grain. Between "three
hours" and "two days" there was no rule at all. `FAILING_CONSECUTIVE_RUNS` is
deleted; `consecutiveLeadingFailures` survives, demoted to choosing WHICH recorded
error the copy names.

**Accepted consequence, stated plainly:** a provider that fails EVERY run now stays
`intermittent` until its tolerance expires rather than escalating after three. That
is the point — it cannot be called broken while its data is still landing, and if
the data genuinely stops, the tolerance catches it. This is a reach REDUCTION only,
which the contact-consent rule permits unilaterally.

The derivation is pure (`lib/integrations/staleness.ts`), instant-grained against
`instantNow()` (the `lib/clock.ts` seam) over `integration_sync_events.at`, which
migration 163 put on the canonical UTC+`Z` convention. Tolerances live beside each
provider's other metadata in `lib/integrations/registry.ts` as
`silenceToleranceMinutes`, read ONLY through `silenceToleranceMinutes()`:

| Provider                                               | Tolerance       | Source                                                                                                                                          |
| ------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| weather                                                | **12 h**        | the default: `DEFAULT_SILENCE_TOLERANCE_POLLS` (12) × its declared 60-minute cadence                                                            |
| strava / oura / withings                               | 3 days          | explicit override, keeping each provider's shipped number and reason                                                                            |
| health-connect                                         | **12 h**        | explicit — a `push` provider has no poll cadence to derive from                                                                                 |
| fitbit-takeout, garmin, patient-portals, calendar-feed | exempt (`null`) | a manual archive has no cadence to be late against, a `planned` provider has no connection, portals run attended, the calendar feed is outbound |

An UNDECLARED tolerance derives from the provider's own poll cadence; a provider
with neither a declaration nor a cadence is caught by the registry completeness test
in `lib/__tests__/sync-staleness.test.ts`, in the `METRIC_KNOWLEDGE` /
fitness-freshness idiom where every entry declares a policy or an explicit exemption
with a reason.

Health Connect's 12 h is measured, not inherited (#2263 decision 3b): over 1223
pushes across 19 days its median gap is 16 min, p90 34 min, and its longest
non-outage silence 1.6 h — while a real outage (a phone-side exporter pushing to a
retired URL that answered `301`, which it did not follow, so nothing ever reached
the server) lasted 16.2 h with **no failure events to classify**. The retired 3-day
value was 45× the observed maximum and would have hidden that for two and a half
more days.

It measures the **sync**, not the data: every polled provider records an `ok=1`
event for each successful poll including a quiet one (`isQuietSync`), so a week
between weigh-ins or a rest week is not silence — which is what makes a per-provider
tolerance safe to state at all.

Three deliberate non-firings: an exempt provider; a provider already carrying a
failing/needs-reauth signal (it is reported ONCE — the reauth item names the
cause, and a silence line naming the symptom underneath it would be noise); and
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
The duration it states is FLOORED and unit-aware (`formatSilence`) — "in 14 hours"
as well as "in 4 days" — because a sub-day silence is escalatable now.
The Data → Review row makes the same distinction — "sync has stopped" instead of
"sync failed", which would claim a failure that never happened.

**…and what it deliberately cannot see: the abandoned device (#2097).** The
paragraph above states it outright — staleness measures the SYNC, not the DATA,
so a rest week is not a broken connection. That is right for the attention
surface and makes the signal structurally unable to answer a different question:
_has this person stopped tracking sleep?_ Someone wears a tracker for months and
then stops, but the phone keeps syncing steps: `ok=1` events with non-zero
inserted counts, green badge, nothing stale. Only the sleep rows end.

The answer is a **data-side** predicate, `isSleepTracking` (`lib/sleep-summary.ts`,
#2102) — the companion to `isLastNight`, since the two are halves of one question:
is last night in hand, and is it even coming. At least 2 of the 3 nights BEFORE
last night must carry a recorded night, which tolerates a forgotten charge while
giving up after two or three consecutive misses. ONE predicate, two consumers: the
morning digest's one-hour deferral (#2102) and the waiting window
(`lib/sleep-waiting.ts`, #2097), so nothing can disagree about whether someone has
stopped. The waiting window checks it BEFORE any clock branch; unguarded the
failure would not merely be a missing check, it would RECUR — "no last night, past
typical wake" is true every morning once someone stops, and `typicalWakeTime` keeps
supplying an anchor for roughly two more weeks.

The two consumers differ only in what they FEED it, and deliberately. The digest
passes every recorded night: deferring a send is a question about whether to wait.
The waiting window passes only the wake-days a SYNCING source recorded, because it
PROMISES an arrival — a manual-only logger has nothing coming, and "waiting" for
something nobody is sending is the message that teaches people to ignore the
surface. Its terminal state adds nothing new: the existing dated label, then the
four-night stale CTA, with a genuinely dead connection still handled by
Data → Review.

**Its health gate is scoped the same way (#2192).** The waiting window also refuses
to speak over a broken connection: saying "waiting" on top of a source that cannot
deliver is a message that cannot resolve. That gate used to read the account-wide
attention list, so an expired Strava token silenced the state on a profile whose
ring was syncing perfectly, and the surface fell back to the stale old-night
headline #2097 exists to remove. It now filters that list to the sources actually
recording this profile's sleep over the same tracking lookback
(`getSyncedSleepSources`). WHICH source that is gets resolved from the DATA — the
way `latestSleepSyncAt` already resolves whose last check the "hasn't synced" line
quotes — rather than from a second hand-kept list of sleep-capable sources for the
registry to drift from. A source that is sleep-capable but is not feeding this
profile's sleep is not what anyone is waiting for anyway.

**…and the same-day version of it: the quiet stream (#2146).** `isSleepTracking`
answers the multi-day question. Between it and connection staleness there was a
gap nothing could see: **connection-level health, data-level silence** — a
provider syncing green while one of its continuous streams has gone quiet _this
afternoon_. The measured case, from 56 days of one real profile's `hr_minutes`:
minutes stop at 21:05, the phone keeps pushing `ok=1` every 15–30 min with
`inserted=0` for that stream while its own daily aggregates keep updating, the
watch spends the night on the charger, and the profile loses its only missing
sleep night in eight weeks. #1685 saw a healthy connection, `currentlyFailingProviders`
saw no recorded failure, and `isSleepTracking` was still true.

**The declaration.** A provider states its CONTINUOUS streams in the registry
beside `silenceToleranceMinutes` (`continuousStreams`, read only through
`lib/integrations/continuous-streams.ts`). Health Connect declares one:
`heart-rate` on `hr_minutes`, ~60 rows/hour, a **2.5 h** dip tolerance, the
**40-minute** bedtime floor #2341 moved here from `lib/wear-reminder.ts`, and the
2-of-3-days activity window it shares with #2097. Both thresholds are **declared,
never inferred** — there is no wear-pattern learner and there must not be one —
and its evidence rides the declaration as data: the measured gap distribution is
bimodal with an empty valley at 2.1–2.5 h, separating 16 routine removals
(1–2.5 h, average 95 min, ten of them the 19:00–21:00 evening charge) from 5 real
events in the whole window.

A provider with **no** continuous stream declares none and is exempt **by
construction** — there is no exemption list to keep in sync. Weather is pulled by
allos and still declares nothing (hourly forecast is not a continuous stream);
Fitbit Takeout is the app's other `hr_minutes` writer and still declares nothing
(an archive has no live cadence to be silent against, so a declaration would
report every profile that ever imported one, forever). The declaration is shaped
as **named streams with independently-optional facets** — `quiet` for detection,
`reminder` for #2161's bedtime send — so it can be enumerated and extended rather
than widened.

**The predicate** (`lib/integrations/quiet-stream.ts`, pure; gathered by
`lib/queries/continuous-streams.ts`):

> the declared stream's **frontier has not moved** across the last N successful
> pushes, and the frontier is older than the stream's declared dip tolerance.

**The first clause is the discriminator (#2341).** It used to read "while the
provider kept syncing ok in that window", and that clause discriminated the
CONNECTION, never the device: a push that is merely _late_ is still a successful
push. What was being thresholded was

```
now − MAX(stream.ts)  =  (minutes the device was not producing) + (ingest lag)
```

and the second term is not small — measured directly on this exporter at **60.8**
and **30.7** minutes from two snapshots at known instants, with #2263's census
over 1223 pushes putting the push gap at median 16 / p90 34 / **p99 67** minutes.
Both terms live in the same range, so **no threshold on that quantity can
separate them**. A watch on a wrist behind a slow pipeline **advances**
`MAX(stream.ts)` across pushes; a watch on a charger leaves it **frozen** while
pushes keep landing. ("On EVERY push" was the false half of that — see N below.) That distinction contains no lag term, and it is what both
readers now ask.

**N is declared per stream, and it is 4 (#2560).** It was `N = 2`, a single
`FROZEN_SYNC_EVIDENCE` constant in `lib/stream-frontier.ts`, defended there as a
property of what a push MEANS rather than of any one stream's wear pattern. That
argument was made against a measurement taken on the wrong leg. There are **two**
batching stages —

```
watch --(Bluetooth, batches coarsely)--> phone Health Connect --(exporter, ~15 min)--> allos
```

— and every #2422 measurement was on the second. The exporter forwards what Health
Connect currently holds; the watch's own sync into it batches independently, and in
the measured window single pushes delivered **324, 195, 183, 165 and 164** minutes
of heart rate at once. Over 1514 pushes: **9% carry no new `hr_minutes` at all**,
and the FRONTIER-ADVANCE interval — the quantity this counter is denominated in —
runs median 16 / p75 25 / **p90 39** / p95 51 / p99 81 / max 183 min, over 30 min
**19.6%** of the time. At `N = 2` that p90 sits on top of the 40-minute floor, so
one long batch satisfies both conditions at once instead of them cross-checking
each other. Scored against whether `hr_minutes` (late, but arriving) later covered
the frozen window, **every clean false positive in 28 days was `k = 2` and every
true detection was `k >= 5`**.

So the bar moved to 4, and it moved **into the registry** as
`ContinuousStreamDef.frozenEvidence` (`{ syncs, because }`), beside
`quiet.dipToleranceMin` and `reminder.frontierFloorMin` and for the same reason:
how many pushes it takes for the SOURCE's state to be reflected is a property of
that source's delivery chain — a device writing straight into its vendor cloud
would need 1. `frontierEvidence(syncs, required)` therefore has **no default**; a
default is exactly how a new stream would inherit another pipeline's batching. Both
readers move together, deliberately: #2146's quiet row is render-only coaching tier,
so a false row there is cheap, and the same batching argument applies to it anyway.
At `N = 4` the 40-minute floor is **dominated** (four quiet pushes is ~64 minutes)
and is kept only because it costs nothing and still states the intent.

**The ceiling this does not raise.** A backlog that drains _through_ a real wear gap
advances the frontier mid-gap and resets the counter — the mirror image of the false
positive, silent at every N, and raising N makes it strictly worse. Nothing about a
frontier can fix it; it is pinned as a documented non-detection in
`lib/__tests__/wear-reminder.test.ts` rather than left to be rediscovered.

The two detectors stay disjoint for the reason they always were, restated: with
the phone off, no push lands, so nothing is ever OBSERVED frozen — that is #1685's
connection outage, which already owns and names it.

**The stored watermark.** `stream_frontiers` (migration 179) holds one row per
`(profile_id, provider, stream)`: the frontier as last observed, when it was last
seen to ADVANCE, when it was last looked at, and how many successful syncs have
landed since. The pure fold is `observeFrontier` (`lib/stream-frontier.ts`); the
ingest-path writer is `lib/stream-frontier-db.ts`; the read is
`readStreamFrontier` in the query module. Not `integration_sync_rows` (its
`target_table` CHECK excludes the stream tables by design, and it stores ~1500
rows/day for this stream alone) and not `window_start`/`window_end` (the
exporter's day-grained rolling window, not a data frontier).

The write runs at the end of a **successful** ingest, in one immediate transaction
that reads `MAX(stream.ts)` and writes the row derived from it — read and write
atomic with respect to each other. It deliberately does **not** piggyback on a
stream upsert's transaction: a push is written in bounded per-chunk transactions
(#1064), so there are N of them, and the push that matters most opens **none** —
a watch on a charger produces no rows, and that push is the entire signal. A push
that threw records nothing.

The detector itself still stores nothing of its own: no marker to set, none to
clear, and a backfill still heals the row retroactively, because a backfilled
batch moves `MAX(ts)` forward and the very next push therefore records an advance.

**Timestamp conventions, joined through their declarations.** The readers span
`hr_minutes.ts` (a canonical UTC instant since migration 164 — it _was_ a
profile-local wall clock), `integration_sync_events.at` (canonical since
migration 163, with pre-163 rows still on SQLite's bare shape),
`stream_frontiers`' three born-canonical instants, and `metric_samples`. Nothing here parses a stored stamp by hand: every read goes
through `eventInstant` (`lib/row-instants.ts`) against the column's declared
meaning in `lib/time-columns.ts`, and every comparison is on epoch milliseconds,
never on text — a bare stamp sorts below a `Z` stamp, which is wrong in a way
that leaves the query looking right (#2096). The DB-tier fixture runs under
`America/New_York` for that reason: under UTC a wall clock and its instant read
alike, so a misread convention passes.

**Where it renders, and where it may not.** Heart rate is an observation
domain — nobody committed to wearing a watch — so the row is **coaching tier,
classes 2/3 only**: a calm card on Data → Review (`components/QuietStreams.tsx`,
slate, not the rose Needs-attention card), with **no push, no digest line, and no
`notify_*` marker**. `AttentionIntegration.kind` gained `"quiet-stream"` beside
`failing`/`stale`, and the tier is enforced rather than documented:
`getQuietStreamAttention` is a separate entry point that the badge, hero and
digest never call, and `isEscalatingIntegration` (`lib/attention.ts`) filters the
kind inside `buildAttentionModel` and the digest's own integration section. The
row also **yields**: a provider already carrying a `failing`/`stale` row is never
also reported quiet, so one row names the cause. It does not count toward the
Data → Review badge — a coaching observation must not inflate an escalation
count.

The one **send** in this family is #2161's opt-in bedtime wear reminder, which
exists only because an explicit Settings → Notifications toggle is the user's
consent. It resolves its provider and stream from the same registry declaration
(the `reminder` facet), reads the stream through the same `latestStreamInstant`,
and since #2341 asks the same frontier question — so the two cannot drift apart
again. They did, twice: the reminder still converted `hr_minutes.ts` with
`zonedWallIsoToUtc` after migration 164, which refuses a stamp carrying `Z`, so it
resolved null for every real row and could not fire at all; and once revived it
fired on its own bare 40-minute constant while its sibling's declared 150-minute
tolerance stayed correctly silent on the same night. Its threshold now lives in
the registry beside that sibling (`reminder.frontierFloorMin`, with its evidence
as data) and is a **floor on the frontier's age**, not the decision.

**…and the lifecycle around both of them: on/offboarding (#2162).** Detection
(#2146), a consented send (#2161) and a multi-day tracking predicate (#2097)
existed without anything joining them up: nothing INTRODUCED the reminder when a
wearable started delivering, and nothing closed the loop when the user stopped
wearing it. `lib/integrations/stream-lifecycle.ts` is that state machine, and it
adds no vocabulary of its own:

```
absent ──▶ appeared ──▶ active ──▶ lapsed ──▶ (data returns ⇒ active) | ended
```

Every state is DERIVED at read time from three facts already stored — the
profile-local day the stream first delivered, the day it last delivered, and the
shared `isStreamActive` gate over the stream's own declared `expectedActive`
window. The enumeration is `allContinuousStreams()`; a provider that declares no
stream has no lifecycle, by construction. Nothing is written when a state
changes, there is no episode table, and a backfill heals the answer retroactively
because it moves those two days. `resumed` is deliberately not a member: a stream
that delivers again IS active, so a resume needs no ceremony, no "welcome back"
and no re-onboarding.

Two guard-order details carry the correctness. `isStreamActive` never inspects
today and needs `minDays` of history, so (a) a stream on its FIRST day is read as
`appeared` rather than `lapsed` — the appeared check runs before the gate — and
(b) a stream that delivered TODAY is active outright, which is the whole of
"resume". Neither is a new number; both are the one day the shared predicate
omits by design.

**The offers, and why neither is a send.** `appeared` on a stream declaring a
`reminder` adapter offers the #2161 bedtime reminder; `ended` (a lapse sustained
past `STREAM_ENDED_AFTER_DAYS`, 14) explains that it paused itself. Both render
on class-2 surfaces only — the integrations page under Data → Import (the
post-connect moment) and a one-time dashboard card — through
`getStreamLifecycleOffers`, which is deliberately its OWN entry point returning
its OWN shape. Nothing it produces is an `AttentionIntegration`, so it cannot
join `getIntegrationAttention`, which is what the morning digest builds a banded
section from; that separation is the same one #2146 drew, for the same reason.

**The consent shape is the load-bearing part.** The Yes tap is the ONLY thing
that turns the setting on, and ignoring the offer enables nothing — a two-button
prompt is fine, default-on is not (#2161 constraint 1), so "opt out" means
"dismiss the offer", never "disable something already on". The offboarding half
is the opposite direction and takes §7's confirm-to-KEEP shape: the reduction
already happened, unilaterally and correctly, when the expected-active gate
closed within days; the prompt announces it and offers **Keep**, which writes only
a dismissal. `setProfileWearReminder` is reachable from exactly two Server Actions,
both bound to a button.

**One-shot semantics live in the KEYS**, on the Upcoming suppression bus (the
dismissal `quietStreamDedupeKey` was reserving space for). `stream-onboard:<provider>:<stream>`
is permanent and `catalog`-class — both tails are registry vocabulary, and a NEW
provider or stream mints a different key, so a second wearable gets its own offer.
`stream-offboard:<provider>:<stream>:<lastDeliveredDay>` is `anchored`-class on the
lapse EPISODE: constant through one lapse, moved by a genuine resume, so a
dismissed prompt never repeats inside its episode and a later lapse arrives
un-silenced. There is no episode row and nothing to sweep.

**Setting-page honesty.** While the gate is closed, Settings → Notifications shows
the bedtime reminder's derived paused state (`wearReminderPausedNote`) beside the
toggle rather than implying tonight's send. The toggle itself is untouched — the
pause is presentation of derived state, never a stored flag, the shape #1668
shipped for the mood check-in's auto-pause.
