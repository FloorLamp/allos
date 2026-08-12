# The time model

Status: partial (phases 0, 1 and 3 shipped — the ingest boundary, storage, the writer
chokepoint, the declared column index and the row-level readers. Phase 2, the
column-name vocabulary, is open: wave 1 landed `occurred_at` on the three observation
stores (migration 165), wave 2 renamed `intake_item_logs.given_at` → `recorded_at`
(migration 173), and wave 3 — the food wave — renamed
`food_log_events.logged_at` → `recorded_at` and `eaten_at` → `occurred_at`
(migration 183). `food_log_events.time_source` is KEPT, by owner ruling on #2205
(2026-08-08): it distinguishes "nobody stated a time" from "someone stated one and the
write path refused it", which `occurred_at IS NULL` collapses. Still to come:
`substance_log.logged_at`, `practice_logs.time`, the window columns
(`start_time`/`end_time` on event tables), the ledger stamps (`at`, `ts`,
`snapshot_at`), and the remaining bare-instant conversions.)

Two questions look the same and are not:

| question                               | stored as                  | example                                              |
| -------------------------------------- | -------------------------- | ---------------------------------------------------- |
| **When did this happen?** (INSTANT)    | UTC, absolute              | `medical_records.occurred_at`, `activities.end_time` |
| **Which day does it count for?** (DAY) | profile-local `YYYY-MM-DD` | `body_metrics.date`, `food_log.date`, dose adherence |

A day is **not** a lesser instant. It is the answer to a different question
(#94): dose, adherence, cadence and the digest all key on it, and several
domains genuinely have no instant at all — a hand-typed weigh-in date is a day
and nothing more. Collapsing the two would be a regression. Everything below is
about instants only, and `date` semantics are untouched throughout.

## The instant convention

```
2026-07-15T20:02:03Z      UTC · second resolution · explicit Z
```

`lib/date.ts` owns it:

| helper             | use                                                       |
| ------------------ | --------------------------------------------------------- |
| `utcInstant(d?)`   | THE writer for a column on this convention                |
| `toUtcInstant(s)`  | re-serialize an already-stored value of either convention |
| `parseUtcSql(s)`   | read a stored value of either convention back to a `Date` |
| `utcSqlString(d?)` | the writer for a column still on SQLite's bare shape      |

`lib/clock.ts` adds the seam wrappers: `instantNow()` beside `sqlNow()`. Which
of the two a write site binds is decided by the **column's** declared
convention, never by the site's taste; the choice between the seam and real
time is the unchanged #1534 rule (day-semantic ⇒ seam, duration ⇒ real time).

Why this shape rather than SQLite's own `datetime('now')`:

- it **states** the zone instead of leaving a reader to assume one;
- it is byte-identical to `strftime('%Y-%m-%dT%H:%M:%SZ','now')`, so a
  JS-written value and a SQL-written one sort, compare and `date()`-truncate
  identically;
- SQLite's date functions parse it natively, so `date()`, `julianday()` and
  `strftime()` keep working over a converted column.

## Why it is enforced rather than documented

Comparison of stored datetimes in SQLite is **lexical**. Within one day, `' '`
(0x20) sorts before `'T'` (0x54), so a bare value and a `Z` value in the same
column — or a `Z` column compared against a bare cutoff — silently answer wrong
while every query still looks right. That is not hypothetical: the boot lease
sweep wrote `integration_backfill_jobs.retry_after_at` bare while the job runner
wrote it with `Z`, and `resumeDueIntegrationBackfills` therefore read every
sweep-paused job as due immediately. The test that covered it seeded the same
bare shape the sweep used, so fixture and code agreed on the wrong serialization
and the assertion passed.

The lesson generalizes: with no declared convention, a test can only pin
whichever shape the writer happened to pick, and a green suite proves nothing
about the comparison. So the convention is a **scan**, not prose.

## The ratchet

`lib/__tests__/instant-writer-scan.test.ts` reads the repo's own source as text
(no DB, no network) and enforces three rules:

- **A** — a column on the canonical convention is written through a bound
  parameter, never SQL's own clock and never a literal.
- **B** — no statement touching a canonical table carries a raw SQL now-read.
- **C** — no module that writes SQL may hand-build an instant
  (`.toISOString()`, a `` `${day} 00:00:00` `` template).

`CANONICAL_INSTANT_COLUMNS` in that file is the registry of columns on the
convention, and there are exactly two ways in:

- **Converted** — the migration that moves an existing column onto the
  convention adds its entry, in the same change as its readers. Never
  speculatively: A and B are enforced immediately, so claiming a column is
  canonical before its values are would fail the statements that are still
  correct.
- **Born on it** — a brand-new nullable column with no rows and no writer yet
  (`occurred_at`, migration 165). There is nothing to convert: the column is
  empty, so the claim cannot be false, and listing it is what keeps it true —
  rule A forces the _first_ writer to bind `utcInstant()` instead of choosing a
  serialization at the call site. This applies only to a column that has never
  held a value.

Everything not listed is still on SQLite's bare shape and is written through
`utcSqlString`/`sqlNow`; that is a phase, not a free-for-all.

Allowlist entries in either the registry or the rule-C ledger **require a stated
reason**, the same discipline as `profile-scoping` and `sql-clock-seam`. A
count that is too low fails as loudly as one that is too high, so the ledger
only shrinks.

Known gaps, stated rather than implied:

- Rule C's gate is "this module writes SQL", so an instant hand-built in a pure
  ingest NORMALIZER is not seen. Those feed `metric_samples`, whose natural-key
  dedupe is keyed on the stored instant — converting them is a value change with
  an idempotency blast radius, so phase 1 leaves them and the registry does not
  claim them.
- Column `DEFAULT`s live in shipped, immutable migrations and cannot be scanned
  from source. A converted table's `DEFAULT` is pinned by its own migration test.

## One reader per question (phase 3)

`lib/date.ts` answers a question about a VALUE. The question a surface actually asks is
about a ROW — "when did this dose happen", "which day does this serving count for" — and
until phase 3 nothing owned it, so `COALESCE(recorded_at, taken_at)` was hand-rolled in six
places and food paired `occurred_at ?? recorded_at` (then spelled
`eaten_at ?? logged_at`) in four more.

`lib/time-columns.ts` declares what every temporal column MEANS, and `lib/row-instants.ts`
asks the row-level question over that declaration: `eventInstant`, `recordInstant`,
`bestKnownInstant`, `rowLocalDay`. A surface names a quantity, never a column, so phase
2's renames reach it through one registry entry.

Two rules are worth repeating here:

- **`eventInstant` never falls back.** A row with no event instant — a web-logged serving
  nobody stated an eating time for, a quick-path practice tick — comes back as an explicit
  absence with a reason. Answering it with the record instant is how a distribution of
  eating times becomes a distribution of tapping times. `bestKnownInstant` still offers the
  substitution and reports which column it used.
- **`localDayOf` (`lib/local-day-window.ts`) stays the single instant→day path.** Phase 3
  adds no synonym for it; `rowLocalDay` routes through it and prefers a row's stored `date`
  whenever it has one, because a day attribution is a decision the app already made (#94).

See `docs/internals/time-columns.md` for the per-column index and the entries that most
reward reading before writing SQL.

## The ingest boundary (phase 0)

Everything above is about a value the app already holds. **Phase 0 is about how one
gets in.** Until #2243, the clinical-document parsers answered a narrower question than
they were asked: `hl7Date` truncated an HL7 v3 TS at its eighth character and `isoDate`
did `v.slice(0, 10)`, so a C-CDA `effectiveTime` of `20260807143000-0500` arrived as a
bare day — three layers before any destination column was chosen. 21% of production's
`medical_records` came in that way. Nothing was wrong at any destination; the value had
already been destroyed at the door.

The rule, stated once:

> **Preserve at the source's own grain; narrow at the destination, per the grain that
> destination declares.**

`lib/source-time.ts` is the boundary. Both parsers return a `SourceTime` — three arms,
because the source genuinely has three cases:

| arm       | the source stated               | reachable destinations                          |
| --------- | ------------------------------- | ----------------------------------------------- |
| `day`     | a calendar day and nothing more | day only                                        |
| `instant` | a time **and** an offset        | day (`sourceDay`) and instant (`sourceInstant`) |
| `local`   | a time with **no** offset       | day only — the instant column stays NULL        |

The third arm is the point: a `string | null` return can never express "a clock with no
zone", so the old signature had to guess, and guessing meant either dropping the time or
resolving it against a timezone nobody supplied.

Three consequences worth stating separately:

- **A day-grained destination reads `sourceDay` and nothing else** — never the offset,
  never a UTC re-derivation. `20260101003000+0900` states the day `2026-01-01` and _is_
  `2025-12-31T15:30:00Z`. Both are right; the day attribution (#94) is the one the
  document stated, and shifting it would be a #2205-constraint-4 regression. The pin
  lives in `lib/__tests__/source-time.test.ts` and again, end to end, in
  `lib/__db_tests__/ccda-source-time.test.ts`.
- **A `local` source leaves an instant destination NULL.** The facility's zone is not
  the patient's, and "usually the same country" is how correct-looking code produces a
  confidently wrong moment. The day is still stored, so nothing that was ever _stated_
  is lost. Facility-zone inference is a separate decision needing its own evidence.
- **Repair is by reprocess, not by migration.** The discarded times were never in the
  database, so there is nothing for a migration to move — but `lib/medical-pipeline.ts`
  retains the source document, so re-parsing the file the app still holds recovers them
  through the affordance that already exists.

Device integrations are untouched: their destinations always wanted instants, so they
already preserved them (`lib/integrations/oura.ts` writes one straight into
`metric_samples.start_time`). #2096 tracks the one device path with the same class of
problem.

### The narrowing ledger

`lib/__tests__/ingest-narrowing-scan.test.ts` is phase 0's ratchet, and it is a
**registry, not a dataflow scan** — a scan cannot follow a value from a parser to a
column. It is the same shape as `HANDBUILT_ALLOW`: every place in the clinical-ingest
surface that still narrows below its source's grain, with a stated reason and a frozen
count that may only shrink. A new narrowing fails; converting one lowers the count.

It currently holds **one** entry, total count 1: `appointmentDateTime` keeps the wall
clock `Appointment.start` printed and drops the offset, because the destination —
`appointments.date` + `appointments.time_of_day`, the CLINIC-local day and wall clock
that #2234's split replaced the old mixed-grain `scheduled_at` with — has no companion
column for a zone anywhere (#2243 owns that question). The parser preserves the
offset; the drop happens at the MAPPER, which knows the destination, rather than at
the parser, which does not.

## Which clock stamps a record instant (#2287)

Storing a stamp in the right SHAPE is not the whole of it. A value SQL stamps
itself — `datetime('now')` in a statement, or a column DEFAULT that reads it —
comes off the **real** clock, which `lib/clock.ts`'s seam cannot reach. Any code
that then compares that value against the seam's `now()` is comparing two
clocks, and answers by the distance between them rather than by the data.

That distance is not always zero. The e2e suite freezes the seam, and
`lib/e2e-freeze-instant.ts` nudges the frozen instant **forward across UTC
midnight** for a run that starts inside its hazard window — so inside that
window the seam leads real time by 30–60 minutes. #2287 reproduced what that
costs, twice:

- `activities.created_at` / `updated_at` are the LIVENESS signal
  `computeWorkoutPresence` subtracts from the seam's now. Stamped by SQL, a
  draft saved seconds earlier read as 58 minutes quiet — past `STALE_MIN` (45)
  — and the dock rendered "Still working out? Finish or discard".
- the offline food replay judged a queued eating-time statement against a bare
  `new Date()` while the statement had been resolved against the seam, so
  `acceptEatenAt` refused a seconds-old statement as being in the future and
  `food_log_events.time_source` landed NULL instead of `'stated'`.

The rule, then: **bind the record instant at the write site from the seam** —
`sqlNow()` for a bare-shaped column, `instantNow()` for a canonical one — and
pass the seam's `now()` to any pure gate that judges a stored or captured
instant. A column DEFAULT lives in a shipped, immutable migration and stays
where it is; binding explicitly at every write path makes it a backstop rather
than the writer. Nothing about this changes production behaviour: with the
override unset the seam **is** the real clock, so the bound value is
byte-identical to what SQLite would have written.

The question to ask of an audit stamp is therefore not "is it merely displayed"
but "does anything ever compare it to the app's now — as a DAY, or as an ELAPSED
interval?" `activities.updated_at` was allowlisted in
`lib/__tests__/sql-clock-seam.test.ts` as a plain last-modified stamp and was
still wrong, because presence subtracts it. `lib/__db_tests__/record-instant-clock-seam.test.ts`
pins both consequences by freezing the seam AHEAD of real time, the way the
nudge does.

## The day-midnight anchor

Three write paths file a day-only reading at `` `${date}T00:00:00` ``
(`lib/reading-writes.ts`, `lib/ttc-store.ts`, `lib/offline/writes.ts`). That
string is a **day attribution** wearing an instant column's clothes, and it is
simultaneously the `metric_samples` natural key that makes a re-entry a
correction rather than a duplicate. It is allowlisted, not converted: moving it
would change a day attribution — out of scope by definition — and break the
dedupe. Folding the three into one helper is phase-3 work.

The three observation stores spell the same absence differently, **on purpose**.
`medical_records`, `body_metrics` and `intake_item_logs` leave `occurred_at`
NULL for an untimed reading (migration 165) rather than anchoring it at
midnight, because each carries a real `date` column and keys on it, so it can
afford honest absence. `metric_samples` cannot: its `start_time` is part of the
natural key, and a NULL there would make a re-entry a duplicate instead of a
correction. Two stores say NULL, one says midnight; that difference is real and
an eventual readings merge has to resolve it, which is why it is named here
rather than hidden behind a uniform-looking anchor.

## The stated-time acceptance gate

A STATED instant — one somebody actually said, as opposed to a stamp the app took
— goes through one gate, `judgeStatedAt` (`lib/stated-time.ts`, #2236), worn by
every surface that records when an observed event happened. Two rules:

1. not meaningfully in the future, tolerating `STATED_FUTURE_SKEW_MS` (five
   minutes — "neither a forgery nor a broken clock"), and
2. the instant's profile-local date IS the row's own `date`.

What a refusal COSTS is the caller's, deliberately. A **log path** keeps the row and
drops the statement: losing the stated minute is cosmetic, losing the food serving is
not. A **correction path**, where the statement is the whole submission, refuses the
write.

What a refusal costs is _not_ silence (#2296, owner ruling 2026-08-08). The gate used
to answer `Date | null`, which cannot distinguish **"nobody stated a time"** from
**"somebody stated one and we refused it"** — so a device whose clock ran more than
five minutes fast discarded the eating time it had just been told, kept the serving,
and said nothing. The tolerance is defensible and stays at five minutes; the shape of
the answer was the defect. `judgeStatedAt` returns a verdict:

| verdict                       | means                                               |
| ----------------------------- | --------------------------------------------------- |
| `{ kind: "accepted", at }`    | use it                                              |
| `{ kind: "unstated" }`        | nobody said — nothing to record, nothing to report  |
| `{ kind: "refused", reason }` | somebody said; `future` / `other-day` / `malformed` |

A refusal is a **notice, never a validation failure that costs the write**. Where it
surfaces:

- **Web food bar** (`app/(app)/nutrition/actions.ts` → `FoodLogBar`) — the ok result
  carries `statedTimeRefused`, and the bar raises an ordinary success-tone toast:
  _"Serving saved without its time — …"_. Online this is only reachable when a page
  goes stale across local midnight, because the form sends the CHOICE and the server
  resolves it; no client clock can push it into the future.
- **Offline replay** (`lib/offline/writes.ts` → `/api/offline-replay` →
  `OfflineQueueProvider`) — the one food path that carries a client INSTANT, and
  therefore the one a fast clock actually bites. The replay stays `done` and adds a
  `timeNotice`; the client folds it into the sync confirmation it already shows
  (`syncedAnnouncement`). Deliberately **not** the red dead-letter panel: that panel
  says "these weren't saved", which would be false here and an alarm for a cosmetic
  loss. See `docs/internals/findings.md` on right-sizing.
- **Correction sheet** — unchanged posture (the statement is the submission, so it
  errors) with the reason now naming the rule that fired, instead of blaming the day
  for a time the user deliberately put in the future.
- **Measurements form** (`app/(app)/trends/measurement-actions.ts` →
  `MeasurementsQuickAdd`, #2311) — the body-metrics half of the same ruling.
  `resolveStatedOccurredAt` answers `{ value, refused }` instead of collapsing a
  refusal into an absence, `insertBodyMetric` answers `BodyMetricWriteOutcome`
  instead of `boolean`, and the action returns `statedTimeRefused`. The form amends
  its own success toast (`measurementsSavedText`, `lib/body-metric-input.ts`):
  _"Measurements saved without the time — that time hasn't happened yet."_ Unlike
  food, this one is reachable ONLINE, because the form posts a resolved instant
  rather than a choice the server resolves. The offline body-metric intent joins the
  food flow's existing `timeNotice` channel unchanged.

Phrasing is per surface; the REASON CODE is shared. `STATED_TIME_REFUSAL_NOTE` is the
clause for a surface that timestamped the statement ITSELF ("your device's clock is
ahead"); a surface where the user TYPED the time owns its own words, because there a
future instant is not a diagnosis of the device. The measurements form is the second
kind: its Time is a field the user can see, so it says "that time hasn't happened
yet" and never diagnoses their clock.

**The whole sitting reports now (#2363).** The vitals half used to be silent:
`insertVitals` answered a bare `boolean` and `ReadingRecordOutcome` had nowhere to
carry a verdict, so a submission with only a blood pressure kept its reading, lost
the stated minute and said nothing — while the very same sitting with a weight
beside it DID report, off the body half. That the answer turned on which fields the
user happened to fill is the tell that the SHAPE was wrong, not the scope.

Both are widened: `ReadingRecordOutcome`'s success arm and `insertVitals` carry
`statedTimeRefused`, and `addMeasurements` answers for the SITTING rather than for
one half of it. Both halves resolve ONE statement through ONE gate
(`resolveStatedOccurredAt`), so their verdicts agree by construction and taking
whichever answered is not a choice between two opinions.

WHO reports is the caller's decision, and both answers are correct:

- a MANUAL sitting reports — the user typed a minute and the app discarded it;
- a NON-MANUAL writer does not, because there is nobody in the room to tell. A
  document import's readings carry the DOCUMENT's stated time, not a user's, and its
  refusals belong in the import report. The fitness battery states a day and no clock
  at all, so its outcome's `statedTimeRefused` is unreachable by construction rather
  than collapsed; the sleep form posts hours for a night, likewise.

The point of widening the type is that this choice is now MADE at each call site,
instead of being made for everyone by a shape that could not carry the answer.
`STATED_FUTURE_SKEW_MS` is unchanged, and a refusal is still a NOTICE: the reading
always lands, and nothing is persisted to chase the user later.

## Related

- #2205 — the umbrella issue, its phasing, and its constraints.
- #2296 — the acceptance gate's verdict, and the ruling that a refused statement is
  never silent.
- #2311 — the same ruling carried to body metrics: the resolver and the write core
  stop collapsing the verdict, and the measurements form says what it could not keep.
- #2363 — the vitals half of the same sitting, and the per-caller rule for who
  reports a refusal and who is right not to.
- #2312 — WHICH clock a replayed capture is judged against. `resolveCapturedInstant`
  now REQUIRES its `now`, so a server-side replay site cannot fall back to the wall
  clock by omission; the dose guard reads the seam like its `isGivenAtAccepted`
  sibling already did. Mood queues no instant at all — its time model is the captured
  `date` — and body/vitals were already on the seam through `resolveStatedOccurredAt`.
- #2522 — the reading half of the same confusion: `formatRelativeTime` bounds its
  future tolerance on BOTH sides, so a genuinely future stated time says "in 7 hrs"
  instead of claiming to have just happened.
- #94 — the day-attribution decision this deliberately does not revisit.
- #2243 — phase 0, the ingest boundary: `lib/source-time.ts`, the three-arm
  `SourceTime`, and the narrowing ledger.
- #2234 / #2096 — the two open narrowings phase 0 names but does not close: an
  appointment's zone, and zoneless Fitbit Takeout timestamps.
- #1534 / `lib/__tests__/sql-clock-seam.test.ts` — the sibling ratchet: WHICH
  clock a now-read comes from. This one is about WHAT SHAPE the value is stored
  in. A write site usually has to satisfy both.
- #2287 — the owner ruling that record instants are stamped through the seam
  rather than by SQL's own clock, and the two reproductions behind it. Part A of
  that issue (a fixture-zone scan and a fixture-timezone registry) is a separate,
  still-open proposal.
- `docs/internals/time-columns.md` — the per-column index (generated from
  `lib/time-columns.ts`) and the row-level readers over it.
- `docs/versioned-migrations-spec.md` — how a converting migration ships.
