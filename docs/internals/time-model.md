# The time model

Status: partial (phase 1 shipping — storage and the writer chokepoint; the
column-name vocabulary and the row-level readers are phases 2 and 3 of #2205)

Two questions look the same and are not:

| question                               | stored as                  | example                                              |
| -------------------------------------- | -------------------------- | ---------------------------------------------------- |
| **When did this happen?** (INSTANT)    | UTC, absolute              | `intake_item_logs.given_at`, `activities.end_time`   |
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

`CANONICAL_INSTANT_COLUMNS` in that file is the registry of converted columns.
An entry is added by the **migration that converts the column**, in the same
change as its readers — never speculatively, because A and B are enforced
against it immediately. Everything not listed is still on SQLite's bare shape
and is written through `utcSqlString`/`sqlNow`; that is a phase, not a
free-for-all.

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

## The day-midnight anchor

Three write paths file a day-only reading at `` `${date}T00:00:00` ``
(`lib/reading-writes.ts`, `lib/ttc-store.ts`, `lib/offline/writes.ts`). That
string is a **day attribution** wearing an instant column's clothes, and it is
simultaneously the `metric_samples` natural key that makes a re-entry a
correction rather than a duplicate. It is allowlisted, not converted: moving it
would change a day attribution — out of scope by definition — and break the
dedupe. Folding the three into one helper is phase-3 work.

## Related

- #2205 — the umbrella issue, its phasing, and its constraints.
- #94 — the day-attribution decision this deliberately does not revisit.
- #1534 / `lib/__tests__/sql-clock-seam.test.ts` — the sibling ratchet: WHICH
  clock a now-read comes from. This one is about WHAT SHAPE the value is stored
  in. A write site usually has to satisfy both.
- `docs/versioned-migrations-spec.md` — how a converting migration ships.
