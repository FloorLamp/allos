# Re-entering a migration body

**Status:** audited (#3590), no change to any shipped migration

`runBootTx`'s bounded `SQLITE_BUSY` retry had never fired: its guard read the
error _message_, and better-sqlite3 puts the result code on `.code`. #3442 fixed
that, so from then on a migration `up()` could genuinely be re-entered. This
records what the 219 shipped bodies do under that, how it was measured, and what
the measurement does not reach.

- `lib/__db_tests__/migration-reentry.test.ts` — the measurement, over every
  shipped body at once, plus the two controls that prove it can see a failure.
- `npm run census:migration-replay` — the classification table below, re-derived
  in about five seconds.

## Two properties, and they are not the same property

**1. On the production path the retry re-enters a body that wrote nothing.**
`lib/db.ts` sets `journal_mode = WAL` before `runMigrations`, and the runner opens
each migration with `BEGIN IMMEDIATE`. In WAL the write lock is exclusive from
`BEGIN`, so a competing writer fails the `BEGIN` itself. Measured on
better-sqlite3 / SQLite 3.53.4: a second `BEGIN IMMEDIATE` raises `SQLITE_BUSY`,
while a peer holding an open read transaction does **not** make the writer's
`COMMIT` fail. A retry on a production boot is therefore a first entry, with zero
statements executed — which is why nothing had ever gone wrong here even before
anyone looked.

**2. When a busy does land mid-body, the runner's transaction undoes the body.**
`lib/migrations/runner.ts` wraps `m.up(db)` **and** the `schema_migrations` insert
in one transaction. SQLite rolls back DDL and DML together, so the retry re-enters
a database identical to the one the first attempt found, and the ledger row can
never exist without the body's work (or the reverse).

The test drives property 2, deliberately in SQLite's default rollback-journal
mode rather than WAL — that is the **only** mode in which a body can write in full
and then meet a busy, so it constructs a harder case than production can produce.
A peer holding a `SHARED` read lock lets `BEGIN IMMEDIATE` take `RESERVED` and
refuses only the `RESERVED -> EXCLUSIVE` upgrade at `COMMIT`. Every busy error in
that file is raised by SQLite, never synthesised.

**Result: with all 219 bodies forced to re-enter exactly once, the resulting
database is identical to a clean run** — same schema, same rows, same
`user_version`, same ledger — apart from the two wall-clock values named below.

## The audit table

Re-applying each `up()` over its own output, measured by
`npm run census:migration-replay` (2026-08-23, 219 migrations):

| Class                                        | Count | Idempotent by what property                                                                                                                                             | Which                                                                                               |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Standalone no-op                             | 215   | Guarded DDL (`PRAGMA table_info` before `ADD COLUMN`, `CREATE … IF NOT EXISTS`), upserts, and converged-state early returns. Safe with or without the runner.           | everything not listed below                                                                         |
| Standalone no-op except a wall-clock value   | 1     | `105-login-notification-channels` upserts its one-shot reconciliation report; only the `at` stamp inside it moves. One row either way.                                  | `105-login-notification-channels`                                                                   |
| Idempotent only under the runner's atomicity | 3     | Unguarded `ALTER TABLE … ADD COLUMN`: a standalone second application raises `duplicate column name`. Unreachable, because the body and its ledger row commit together. | `20260822-intake-source-name`, `20260822-logged-via-provenance`, `20260823-telemetry-source-answer` |

The three in the last row are **not** a defect and were not changed. No path
applies a body twice: `runMigrations` is the only caller in `lib/`, `app/` and
`scripts/` (`scripts/restore.ts` reads `MIGRATIONS.length` for a version gate and
nothing else), and every direct `m.up()` call in the tree is a DB-tier test
building a historical fixture. They are recorded because the 215-strong guarded
convention is worth knowing you have left — several of those 215 say so in their
own header, in wording that dates from a `migrate()` test wrapper which replayed
bodies unconditionally and is ledger-gated now like everything else.

## What escapes the transaction

Three things a rollback cannot undo. All three were looked for across all 219
bodies; these are what is there.

- **Log lines.** `20260813-cascade-orphan-sweep` and
  `20260813-saved-backed-identity-repair` call `log.info`/`log.warn` inside
  `up()`, so a re-entered boot prints their line twice. Informational, no state.
- **Wall-clock values.** `105-login-notification-channels` stamps its report with
  `new Date().toISOString()` (upserted), and `20260821-hc-overlap-supersede`
  writes `hc_overlap_unstamped_era_at` with `ON CONFLICT DO NOTHING` — first write
  wins across boots, but a rolled-back attempt takes that guard with it, so the
  retry records a later instant. It reads its paired
  `hc_overlap_unstamped_era_max_id` in the **same** body, so the pair stays
  internally consistent and the marker still means what its header says.
- **Nothing else.** No migration opens a second database connection, touches the
  filesystem, reads `process.env`, or makes a network call — the only imports
  across the 219 files are `../runner`, `better-sqlite3`, and pure `lib/` helpers.
  None declares a module-level `let` or `var`; every module-scope binding is a
  `const` holding constant data or SQL text, so there is no accumulator to carry
  state across a retry. None issues `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` as
  SQL, `ATTACH`, or `VACUUM`; the 53 that call `db.transaction(…)` nest as a
  `SAVEPOINT` under the runner's transaction, which is what better-sqlite3 does
  with a nested transaction. The two that use `node:crypto` call `createHash`.

## What this does not reach

The re-entry measurement replays the chain into a **fresh** database, so every
data-backfill body runs against empty tables. What covers those is property 2 —
the rollback restores the pre-attempt state whatever is in it — and not the
comparison, which cannot tell a correctly re-entered backfill from one that had
no rows to touch. A body that behaves differently against populated tables would
have to do it _outside_ the transaction to survive a rollback, and the census
above is what says none of them does.
