# Spec: Versioned migration runner (`PRAGMA user_version`)

Status: **draft** · Owner: TBD · Tracking issue: TBD

## Problem

`lib/db.ts` has no migration tool: `migrate()` re-applies the whole schema on
every boot with `CREATE TABLE IF NOT EXISTS`. Because that re-apply no-ops on
existing databases, every non-trivial change has grown its own bespoke
workaround, and each one exists **only** because there is no ordered,
versioned record of "which schema changes has this DB already received":

- **`addColumnIfMissing()` + `ADDITIVE_COLUMNS`** — additive columns, plus an
  observational registry so `lib/__db_tests__/migrate.test.ts` can
  reverse-engineer an "old release" schema by stripping them.
- **`ENUM_CHECKS` + `reconcileEnumChecks()`** (#91) — inline enum `CHECK`
  constraints freeze at first CREATE, so a registry + boot-time drift detection
  against `sqlite_master.sql` decides when to do a row-preserving table
  rebuild. Kept in sync by hand, guarded by
  `lib/__db_tests__/enum-check-drift.test.ts`.
- **Settings-flag one-shots** — `migrateMultiUserSettings()`
  (`multi_user_settings_v1`), `migrateLiftMerges()`, etc. each invent a marker
  row in `settings` to run exactly once.
- **Rename shims** — `renameAuthTablesForBranch()`,
  `migrateWeighInsToBodyMetrics()`, `migrateSupplementsToIntakeItems()` probe
  for old table names on every boot, forever.
- **Structural rebuilds** — `rebuildForProfileScoping()`,
  `rebuildMetricSamplesSourceKey()`, `relaxBodyMetricsWeightKg()` each
  re-detect "has this rebuild happened?" from the live schema shape on every
  boot.

Each mechanism is individually sound, but the pattern is the problem: every
new class of change requires inventing a new idempotency/detection scheme,
`migrate()` accretes them permanently (every boot re-probes all of history),
and correctness rests on hand-written "is it already done?" checks instead of
a version number.

## Proposal

A minimal versioned migration runner (~50 lines, zero dependencies) using
SQLite's built-in **`PRAGMA user_version`** as the schema-version slot.
Migrations are ordered, append-only, synchronous TypeScript functions with
full access to the `better-sqlite3` handle. The entire current `migrate()`
body becomes **migration 001 ("baseline")** and is frozen; all future schema
changes are appended as new numbered migrations.

### Non-goals

- No ORM, query builder, or schema-definition DSL — SQL stays inline
  (`db.prepare(...)`/`db.exec(...)`), the profile-scoping test keeps working
  on plain source text.
- No `down()` migrations. Recovery from a bad deploy is restore-from-backup
  (`scripts/restore.ts`), same as today.
- No CLI / out-of-band migrate step. Migrations keep running in-process at
  boot; the Docker deploy story is unchanged.
- No rewriting of history that already shipped: the baseline keeps
  `addColumnIfMissing`, `ENUM_CHECKS` reconciliation, settings flags, and
  rename shims exactly as they are — frozen, not re-implemented. Those
  mechanisms are **closed to new entries**, not removed.
- No squashing plan. If baseline replay ever becomes a measurable fresh-boot
  cost (unlikely: it is DDL + empty-table scans), squashing can be designed
  then.

## Design

### Layout

```
lib/migrations/
  runner.ts             # readVersion / runMigrations / guards
  versions/
    index.ts            # export const MIGRATIONS: Migration[] (ordered)
    001-baseline.ts     # the current migrate() body, verbatim, frozen
    002-<slug>.ts       # first post-runner change, and so on
  manifest.json         # { "001-baseline.ts": "<sha256>", ... } (checked in)
```

```ts
// runner.ts
export interface Migration {
  id: number; // 1-based, contiguous, === position in MIGRATIONS
  name: string; // matches the file slug
  up(db: Database.Database): void; // synchronous; runs inside the runner's txn
}
```

### Runner semantics

```
version = PRAGMA user_version
if version > MIGRATIONS.length: fail boot (see “Downgrade guard”)
for each m in MIGRATIONS where m.id > version:
  runBootTx(IMMEDIATE):
    re-read user_version inside the txn; skip if already >= m.id
    m.up(db)
    PRAGMA user_version = m.id
```

- **One transaction per migration**, `BEGIN IMMEDIATE`, with the existing
  `runBootTx()` bounded `SQLITE_BUSY` retry. Rationale is unchanged from
  today: parallel `next build` workers all import `lib/db.ts` and race the
  boot path; IMMEDIATE takes the write lock at BEGIN and the in-transaction
  version re-read makes losing workers no-op. This replaces per-mechanism
  idempotency with one structural guarantee.
  - Caveat carried over from today: `PRAGMA user_version` writes are DDL-ish
    but transactional in SQLite; the in-txn re-read is the authoritative
    dedup, not the pragma's atomicity.
- **Fresh and upgraded DBs take the same path.** A fresh DB is simply
  `user_version = 0` and replays baseline + everything after it. There is no
  separate "current schema" apply, so fresh and upgraded databases cannot
  diverge — the property the current single-path `migrate()` already has, and
  the reason the baseline is kept as a replayable migration instead of a
  frozen snapshot + separate fresh-boot path.
- **Append-only.** A shipped migration file is never edited (see CI guards).
  Fixing a bad migration means appending a corrective one.
- **Migrations are code, not SQL files.** Data backfills (e.g. the
  `medical_records.value_num` cast), row-preserving table rebuilds (the #91
  create→copy→drop→rename dance via `rebuildTable`), and multi-statement
  changes are plain synchronous TS. Helpers in `lib/migrations/schema-utils.ts`
  stay available.
- **Determinism rule:** a migration may read only the DB and its own
  constants — no env vars, no `Date.now()`-dependent branching, no imports of
  live registries that evolve (`ENUM_CHECKS`, `lib/owned-tables.ts`,
  `canonical-biomarkers.json`). Baseline is grandfathered (it already imports
  the registries); the rule applies from 002 on, enforced by review + the
  hash manifest making any drift-by-imported-value visible as a behavior bug
  rather than a silent one. Where a new migration needs a table list or enum
  set, it inlines its own copy.

### Downgrade guard

If `user_version > MIGRATIONS.length` (a rolled-back image booting against a
newer DB), **fail the boot** with a clear error naming both versions and
pointing at `scripts/restore.ts`. Today this scenario silently "works" until
the old code hits a shape it doesn't know; failing fast is a deliberate
behavior change and gets a release-note line. No env escape hatch — an
operator who genuinely wants to run old code restores the matching backup.

### What stays outside the runner (per-boot tasks)

`migrate()`'s current tail is not schema migration and keeps running on every
boot, after the runner, in a `bootTasks(db)` step:

- `bootstrapAuth()` — env-dependent (`ADMIN_USERNAME`/`ADMIN_PASSWORD`),
  creates the bootstrap admin/profile only when missing.
- `reconcileFlagsIfCanonicalChanged()` — gated on the
  `canonical-flags-version.ts` content signature, not schema version; ranges
  can change in a release with no schema change.
- Stuck-state cleanup (`medical_documents.extraction_status`,
  `import_jobs.status`) — must run on **every** process start by design.
- `seedTimezoneFromEnv()` — env-dependent first-boot seeding.

`backfillProfileIds()` is the one judgment call: it is also a resurrection
guard tied to live inserts (#deleted-profile-1 rules), so it stays a boot task
rather than being frozen into baseline. Document this in the code.

### What changes for contributors (AGENTS.md update ships in the same PR)

| Change class       | Today                                           | After                                           |
| ------------------ | ----------------------------------------------- | ----------------------------------------------- |
| New table          | add CREATE block                                | append migration with the CREATE                |
| New column         | `addColumnIfMissing()` (+ registry side effect) | append migration: `ALTER TABLE … ADD COLUMN`    |
| Grow an enum CHECK | edit CREATE block **and** `ENUM_CHECKS` entry   | append migration: rebuild table with new CHECK  |
| One-shot data move | invent a settings flag                          | append migration (runs exactly once by version) |
| Table/key rebuild  | boot-time shape probe + rebuild helper          | append migration                                |

The CREATE blocks in baseline are **frozen**: a new column is _not_ added to
the historical CREATE. The current schema is no longer readable from one
place in source; `npm run schema:dump` (new tiny script printing
`sqlite_master` from a scratch in-memory DB after all migrations) fills that
gap for humans, and tests assert against the same dump.

### Test plan

Existing tiers keep their roles; the DB tier gets stronger and simpler:

- **`lib/__db_tests__/runner.test.ts`** (new): fresh in-memory DB → run all →
  `user_version === MIGRATIONS.length`; ids are contiguous and match array
  position; re-running is a total no-op; a DB stamped at version N only
  receives N+1…; `user_version` ahead of code fails with the downgrade error.
- **Immutability guard** (new, pure tier): recompute sha-256 of each
  `versions/*.ts` and compare to `manifest.json`. A hash mismatch fails CI
  with "shipped migrations are append-only — add a new migration instead".
  Adding a file requires adding its hash line (same diff), so review sees
  both. Baseline's hash is pinned like any other.
- **Upgrade-path test**: `lib/__db_tests__/migrate.test.ts`'s "strip
  `ADDITIVE_COLUMNS`, re-run" reconstruction becomes obsolete for the
  post-runner era — the real old schema **is** "replay migrations 1…N".
  Keep the existing reconstruction test for baseline itself (it guards the
  frozen era), and add: build DB at version N, assert migrations N+1… apply
  cleanly, for each N ≥ 1.
- **Schema-equivalence is by construction** (single path), so no fresh-vs-
  upgraded diff test is needed — this is the property that made the old
  reconstruction test necessary.
- The enum-check drift test and `ENUM_CHECKS` registry remain, scoped to the
  frozen baseline CREATEs; a lint-style pure test asserts no _new_ callers of
  `addColumnIfMissing`/`ENUM_CHECKS` entries appear outside
  `001-baseline.ts` (mechanism closed, not removed).

### Rollout

Single PR, no data risk (baseline is byte-for-byte today's `migrate()`):

1. Introduce `runner.ts` + `versions/001-baseline.ts` (move, don't rewrite,
   the `migrate()` body) + `manifest.json` + the new tests. `lib/db.ts`'s
   `createDb()` calls `runMigrations(db)` then `bootTasks(db)`.
2. Existing deployed DBs are at `user_version = 0` → they run baseline once
   (identical to every boot they already do) and get stamped to 1. Fresh DBs
   are identical. **No observable behavior change** except the stamp and the
   downgrade guard.
3. Update AGENTS.md ("Architecture → lib/db.ts" and the change-class table
   above) and the PR-template checklist line if needed. README is unaffected
   (no user-visible change).
4. First real consumer lands as `002-*` in its own feature PR, proving the
   workflow.

### Risks

- **Frozen baseline still imports live registries** (`ENUM_CHECKS`,
  `BACKFILL_OWNED_TABLES`): if those grow for a _new_ migration's benefit,
  baseline's behavior changes retroactively for not-yet-stamped DBs. Mitigated
  by closing the registries (lint test above) — new work inlines its own
  constants.
- **Append-only discipline** is new muscle memory; the hash manifest makes
  violations un-mergeable rather than relying on review.
- **Rollback UX regression** (downgrade guard fails fast where today it limps)
  — intentional, but needs a clear error message and a line in the deploy
  docs.
