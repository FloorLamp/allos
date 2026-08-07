# The time model

Status: partial (phases 1 and 3 shipped — storage, the writer chokepoint, the declared
column index and the row-level readers. Phase 2, the column-name vocabulary, is open:
wave 1 landed `occurred_at` on the three observation stores (migration 165); the
`given_at` → `recorded_at` rename is still to come.)

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
until phase 3 nothing owned it, so `COALESCE(given_at, taken_at)` was hand-rolled in six
places and food paired `eaten_at ?? logged_at` in four more.

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

## Related

- #2205 — the umbrella issue, its phasing, and its constraints.
- #94 — the day-attribution decision this deliberately does not revisit.
- #1534 / `lib/__tests__/sql-clock-seam.test.ts` — the sibling ratchet: WHICH
  clock a now-read comes from. This one is about WHAT SHAPE the value is stored
  in. A write site usually has to satisfy both.
- `docs/internals/time-columns.md` — the per-column index (generated from
  `lib/time-columns.ts`) and the row-level readers over it.
- `docs/versioned-migrations-spec.md` — how a converting migration ships.
