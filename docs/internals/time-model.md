# The time model

Status: Implemented primitives and readers; stored serialization remains
column-specific, with mixed and unverified entries in the column registry.

An **instant** answers when something happened. A **local day** answers which
calendar day it belongs to. A **local clock time** needs a date and timezone to
become an instant. Preserve these distinctions at input, storage, and display
boundaries; an unstated event time must not acquire invented precision.

Use the [change and test policy](../change-policy.md) for scope and verification.
The [temporal-column index](time-columns.md) owns each column's meaning, grain,
serialization, and exceptions, plus the row-reader API. Consult it before changing
SQL or choosing between event time and capture time.

## Stored formats and writers

[date.ts](../../lib/date.ts) owns serialization:

| Helper             | Use                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `utcInstant(d?)`   | Canonical UTC, second resolution: `2026-07-15T20:02:03Z`                                         |
| `utcMinute(d)`     | Canonical UTC truncated to a minute                                                              |
| `utcSqlString(d?)` | Bare UTC: `2026-07-15 20:02:03`                                                                  |
| `toUtcInstant(s)`  | Parse a stored UTC value and normalize it to canonical form; null for absent or unreadable input |
| `parseUtcSql(s)`   | Parse stored UTC timestamps, including explicit offsets; zoneless values are interpreted as UTC  |

Choose a writer from the **destination column's convention**. Do not treat a
clinic-local datetime as UTC merely because `parseUtcSql` accepts its shape.
Use the domain timezone when resolving a local wall clock.

SQL text comparisons depend on serialization: a space sorts before `T`, so
mixing bare and canonical timestamps can produce incorrect ordering or cutoffs
within the same day. Bind cutoffs in the column's convention. Declaring a column
canonical requires its stored values, defaults, writers, and readers to agree;
changing only the TypeScript return type does not convert existing data.

For an existing column, coordinate normalization with its readers and a new
[migration](../versioned-migrations-spec.md). A new empty column can start on the
canonical convention. Mixed and unverified columns require their documented
handling; absence from the canonical-writer scan is not evidence that a column
uses the bare format.

## Choose the clock as well as the format

[clock.ts](../../lib/clock.ts) owns the app's `now()`, with `instantNow()` and
`sqlNow()` for canonical and bare stamps. `ALLOS_TEST_NOW` can fix this clock
across processes; it is a test hook. Without a valid override, `now()` uses the
real clock. The helper does not replace global `Date` or timers.

Use this clock for day-derived behavior and for stored/captured instants compared
against the app's now. Bind the record stamp explicitly when a SQL default would
read a different clock. This includes activity presence and acceptance of
replayed event times. Pass the chosen `now` into pure gates;
`resolveCapturedInstant` in [offline/queue.ts](../../lib/offline/queue.ts)
requires it explicitly.

Timers, session expiry, rate limits, and other operational durations use real
time. The persisted `notify_post_workout_claims.claimed_at` lease is an explicit
exception: both its writer and age comparison use the app clock. A monotonic
timer cannot serve as a shared persisted anchor across processes.

The [SQL clock check](../../lib/__tests__/sql-clock-seam.test.ts) records the
remaining raw-clock sites and their reasons. Check the consumer's comparison,
not just whether a timestamp looks like an audit field. Test-clock setup belongs
in [E2E hygiene](e2e-hygiene.md) and the existing test-tier fixtures.

## Temporal types

[temporal-types.ts](../../lib/temporal-types.ts) declares four string brands:

| Type               | Meaning                           | Existing constructors or validators                                      |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------ |
| `LocalDay`         | Real `YYYY-MM-DD` calendar day    | `isRealIsoDate`, `dateStrInTz`, `shiftDateStr`, `today`                  |
| `LocalTime`        | `HH:MM` local clock time          | `zonedDateParts`, `nowTime`, `activityClockHHMM`                         |
| `CanonicalInstant` | UTC with seconds and explicit `Z` | `utcInstant`, `utcMinute`, `toUtcInstant`, `instantNow`, `sourceInstant` |
| `BareInstant`      | UTC in SQLite's bare format       | `utcSqlString`, `sqlNow`                                                 |

Obtain a brand by validation or construction. Do not cast an arbitrary string or
hide the cast in a new helper. A DB row assertion may carry the brand supported
by that column's registry entry and storage contract. Narrow consumer parameters
as they are changed; a branded return alone does not check a string-typed consumer.

`DisplayText` accepts ordinary text but excludes `LocalDay`. Search's `subtitleOf`
preserves tuple element types so mixing text with a day cannot silently widen it
to `string[]`. Format the day before passing it; interpolation or an explicit
string annotation erases the brand and still needs review.

The existing ESLint restriction catches enumerated cast and alias spellings. It
is not type resolution or runtime validation: indirect types, dishonest predicates,
`any`, and other type-system escapes still need review. Keep legitimate constructor
casts at their existing owners rather than adding exceptions at callers.

## Source precision and day attribution

[source-time.ts](../../lib/source-time.ts) distinguishes what a clinical source
states before the destination decides what to store:

| `SourceTime` grain | Source information                 | Destination readers                       |
| ------------------ | ---------------------------------- | ----------------------------------------- |
| `day`              | Calendar day                       | `sourceDay`                               |
| `instant`          | Time with an offset                | `sourceDay` and `sourceInstant`           |
| `local`            | Clock time without a usable offset | `sourceDay`; `sourceInstant` returns null |

`sourceDay` keeps the source's printed day. For example, `20260101003000+0900`
states January 1 even though its UTC instant is December 31. Do not rederive a
day-grained destination from UTC. A facility-local clock cannot be resolved using
the patient's timezone without evidence that it is the correct zone.

The FHIR appointment mapper keeps the clinic-local day and clock in
`appointments.date` and `time_of_day`; those columns have no companion timezone.
The mapper makes that narrowing decision, not the parser. The
[ingest narrowing check](../../lib/__tests__/ingest-narrowing-scan.test.ts)
tracks textual narrowing patterns in clinical parsers and mappers. It does not
trace data flow, cover device integrations, or detect precision discarded by an
AI extraction prompt.

When an earlier parse discarded source time, recovery requires reprocessing a
retained source document. A migration cannot reconstruct information absent from
storage.

## Day anchors and unknown event times

`metric_samples.started_at` participates in a natural key and retains several
writer-specific shapes. It is not branded as a canonical or bare instant.
Normalizing it can change deduplication and turn a correction into another row.
Read its registry notes before changing a writer or comparison.

Manual day-only point readings in `reading-writes.ts`, `ttc-store.ts`, and
`offline/writes.ts` use a stable `YYYY-MM-DDT00:00:00` key. This is day attribution,
not evidence that the event happened at midnight. Conversely, untimed
`medical_records`, `body_metrics`, and `intake_item_logs` can leave `occurred_at`
null because they have a separate day column. Preserve each store's identity and
absence semantics when consolidating readers or writes.

## Accepting a stated event time

[judgeStatedAt](../../lib/stated-time.ts) checks a supplied instant against the
row's profile-local day and a caller-supplied `now`. It rejects malformed times,
times more than `STATED_FUTURE_SKEW_MS` (five minutes) in the future, and times on
another local day. Its result distinguishes `accepted`, `unstated`, and
`refused`, with `future`, `other-day`, or `malformed` as the refusal reason.

An additive log keeps a valid reading while dropping a refused time statement.
A correction whose submission is the time itself refuses the correction. Do not
collapse refusal into absence or report that a successfully saved row failed.

Food and measurement actions carry `statedTimeRefused` to the calling surface.
[resolveStatedOccurredAt](../../lib/reading-writes.ts) preserves the refusal in
body and vital outcomes; the measurement action reports for the whole sitting.
Offline replay carries the notice through `timeNotice` while the write remains
synced. Use the existing success or sync feedback, not the failed-write queue.

Keep the reason code shared and wording appropriate to the input. A user-entered
future time does not establish that the device clock is wrong. Non-manual imports
and day-only inputs have different reporting needs; handle the outcome at their
own boundary. Relative-time display must also preserve future meaning rather than
labeling every future instant as “just now.”

## Verification boundaries

The [instant-writer check](../../lib/__tests__/instant-writer-scan.test.ts)
requires recognized writes to registered canonical columns to bind parameters,
rejects raw SQL now-reads in statements touching registered tables, and counts
hand-built instant patterns in SQL-writing modules against explained exceptions.
It does not prove bound values are canonical, inspect every pure normalizer, or
validate stored data and shipped defaults. Use the relevant domain or migration
coverage for those properties.

Reuse existing temporal-type, source-time, row-reader, stated-time, and clock
coverage for their respective behavior. Add a focused case only for an uncovered
failure; the presence of a registry, brand, or source scan is not a substitute for
checking the value's meaning at the boundary being changed.
