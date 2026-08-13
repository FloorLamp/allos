# Spec: Versioned migration runner (`PRAGMA user_version`)

Status: **shipped** · Tracking issue:
[#119](https://github.com/FloorLamp/allos/issues/119)

> **Status: shipped — this reads as documentation, not a proposal.** The runner
> described here is built and matches `lib/migrations/`: the
> `PRAGMA user_version` gate + `BEGIN IMMEDIATE`-per-migration runner
> (`lib/migrations/runner.ts`), the append-only `lib/migrations/versions/` set
> headed by the clean-apply `001-baseline.ts`, the checked-in immutability
> `manifest.json`, the downgrade guard, and the per-boot tasks kept outside the
> runner (`boot-tasks.ts`). Later design choices (the baseline-is-a-clean-apply
> decision, the dropped legacy upgrade machinery) are recorded in the Revision
> below and are the shipped behavior. Kept for the rationale; the code is the
> source of truth.

## Revision (2026-08-12) — the numbered era closes; migrations are name-keyed

The sequential integer was the one piece of this design that fought the way the
repo actually develops: with many agents working in parallel, the next free
number was a contended, session-held reservation (the orchestration runbook
grew a whole slot-map protocol, a renumber recipe used three times, and an
"unhonorable until the earlier one merges" rule), and `assertContiguousIds`
made a numbering gap fail every DB test file at import. None of that contention
bought correctness — order is what matters, and order was always the
`MIGRATIONS` array.

So the applied-set moved off `PRAGMA user_version` onto a **`schema_migrations`
ledger keyed by migration NAME**, created by the runner itself (every
historical database gains it on its next boot, backfilled from its
`user_version` stamp, which by the old contiguity invariant names exactly
migrations 1..V):

- **Migrations 001–185 are the closed numbered era** — files, ids and hashes
  frozen exactly as shipped. The runner refuses a numbered migration after the
  first name-keyed one.
- **A new migration is `versions/YYYYMMDD-slug.ts`**, exports
  `{ name, up }` with no `id`, is appended LAST to the array, and adds its
  sha256 to `manifest.json`. Names are the ledger's primary key; uniqueness and
  the two filename shapes are enforced by `assertRegistry` at boot and
  `lib/__tests__/migration-immutability.test.ts` in CI.
- **The array stays the single ordering authority** (deliberately not filename
  sort: date prefixes from parallel branches interleave, and fresh databases
  must replay in the same order deployed ones received). Production applied
  sets are always a prefix of the array because main is linear; a DEV database
  that applied a branch migration and then merged main simply has the missing
  earlier one applied late, which the runner tolerates by design.
- **`PRAGMA user_version` survives as a monotonic applied-count tripwire**: it
  keeps climbing past 185 so pre-ledger builds refuse a newer database, and the
  backup/restore version gate (#472) keeps comparing it against the build's
  migration count unchanged. The ledger is authoritative; the pragma is a
  tripwire. The primary downgrade guard is now name-based — a ledger row this
  build does not know fails the boot naming it.
- **Re-baselining was considered and declined**: the full 185-migration replay
  on a fresh database measures ~0.4–0.5 s (no single migration over 25 ms), the
  chain is hash-frozen so it costs no maintenance, and a snapshot would add a
  chain-equivalence proof obligation plus an upgrade-path constraint for
  operators who skip versions. Revisit only if fresh-database replay time
  becomes a measured problem (CI or operator-visible), the same
  recorded-trigger posture as the reading-model phase 3.

## Revision (2026-07-10)

Owner decision at implementation review: the "no rewriting of history that
already shipped" non-goal below is **superseded**. Baseline (`001-baseline.ts`)
is a **clean apply of the schema at the runner's introduction** — every table
then current with its final columns, CHECKs, and index set — and the pre-runner
upgrade machinery was **dropped**,
not frozen: no rename shims, no `addColumnIfMissing`/`ADDITIVE_COLUMNS`, no
`ENUM_CHECKS` reconcile, no profile-scoping rebuilds/index swaps, no
settings-flag one-shots, no legacy data backfills. All deployments are assumed
to already be on that pre-runner schema (baseline replays as a pure
`IF NOT EXISTS` no-op before the v1 stamp); a deployment on an **older** release must first step
through the last pre-runner release before upgrading to one that carries the
runner. `backfillProfileIds` was likewise dropped from the boot tasks — from the
baseline onward every owned table is born `profile_id NOT NULL` and every write
path supplies it, so the legacy NULL rows it adopted cannot exist. A fresh
database reaches today's schema by applying baseline and every later migration.

## Problem

`lib/db.ts` has no migration tool: `migrate()` re-applies the whole schema on
every boot with `CREATE TABLE IF NOT EXISTS`. Because that re-apply no-ops on
existing databases, every non-trivial change has grown its own bespoke
workaround, and each one exists **only** because there is no ordered, versioned
record of "which schema changes has this DB already received":

- **`addColumnIfMissing()` + `ADDITIVE_COLUMNS`** — additive columns, plus an
  observational registry so `lib/__db_tests__/migrate.test.ts` can
  reverse-engineer an "old release" schema by stripping them.
- **`ENUM_CHECKS` + `reconcileEnumChecks()`** (#91) — inline enum `CHECK`
  constraints freeze at first CREATE, so a registry + boot-time drift detection
  against `sqlite_master.sql` decides when to do a row-preserving table rebuild.
  Kept in sync by hand, guarded by `lib/__db_tests__/enum-check-drift.test.ts`.
- **Settings-flag one-shots** — `migrateMultiUserSettings()`
  (`multi_user_settings_v1`), `migrateLiftMerges()`, etc. each invent a marker
  row in `settings` to run exactly once.
- **Rename shims** — `renameAuthTablesForBranch()`,
  `migrateWeighInsToBodyMetrics()`, `migrateSupplementsToIntakeItems()` probe
  for old table names on every boot, forever.
- **Structural rebuilds** — `rebuildForProfileScoping()`,
  `rebuildMetricSamplesSourceKey()`, `relaxBodyMetricsWeightKg()` each re-detect
  "has this rebuild happened?" from the live schema shape on every boot.

Each mechanism is individually sound, but the pattern is the problem: every new
class of change requires inventing a new idempotency/detection scheme,
`migrate()` accretes them permanently (every boot re-probes all of history), and
correctness rests on hand-written "is it already done?" checks instead of a
version number.

## Proposal

A minimal versioned migration runner (~50 lines, zero dependencies) using
SQLite's built-in **`PRAGMA user_version`** as the schema-version slot.
Migrations are ordered, append-only, synchronous TypeScript functions with full
access to the `better-sqlite3` handle. The entire current `migrate()` body
becomes **migration 001 ("baseline")** and is frozen; all future schema changes
are appended as new numbered migrations.

### Non-goals

- No ORM, query builder, or schema-definition DSL — SQL stays inline
  (`db.prepare(...)`/`db.exec(...)`), the profile-scoping test keeps working on
  plain source text.
- No `down()` migrations. Recovery from a bad deploy is restore-from-backup
  (`scripts/restore.ts`), same as today.
- No CLI / out-of-band migrate step. Migrations keep running in-process at boot;
  the Docker deploy story is unchanged.
- No rewriting of history that already shipped: the baseline keeps
  `addColumnIfMissing`, `ENUM_CHECKS` reconciliation, settings flags, and rename
  shims exactly as they are — frozen, not re-implemented. Those mechanisms are
  **closed to new entries**, not removed.
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
  `runBootTx()` bounded `SQLITE_BUSY` retry. Rationale is unchanged from today:
  parallel `next build` workers all import `lib/db.ts` and race the boot path;
  IMMEDIATE takes the write lock at BEGIN and the in-transaction version re-read
  makes losing workers no-op. This replaces per-mechanism idempotency with one
  structural guarantee.
  - Caveat carried over from today: `PRAGMA user_version` writes are DDL-ish but
    transactional in SQLite; the in-txn re-read is the authoritative dedup, not
    the pragma's atomicity.
- **Fresh and upgraded DBs take the same path.** A fresh DB is simply
  `user_version = 0` and replays baseline + everything after it. There is no
  separate "current schema" apply, so fresh and upgraded databases cannot
  diverge — the property the current single-path `migrate()` already has, and
  the reason the baseline is kept as a replayable migration instead of a frozen
  snapshot + separate fresh-boot path.
- **Append-only.** A shipped migration file is never edited (see CI guards).
  Fixing a bad migration means appending a corrective one.
- **Migrations are code, not SQL files.** Data backfills (e.g. the
  `medical_records.value_num` cast), row-preserving table rebuilds (the #91
  create→copy→drop→rename dance via `rebuildTable`), and multi-statement changes
  are plain synchronous TS. Helpers in `lib/migrations/schema-utils.ts` stay
  available.
- **Determinism rule:** a migration may read only the DB and its own constants —
  no env vars, no `Date.now()`-dependent branching, no imports of live
  registries that evolve (`ENUM_CHECKS`, `lib/owned-tables.ts`,
  `canonical-biomarkers.json`). Baseline is grandfathered (it already imports
  the registries); the rule applies from 002 on, enforced by review + the hash
  manifest making any drift-by-imported-value visible as a behavior bug rather
  than a silent one. Where a new migration needs a table list or enum set, it
  inlines its own copy.

### Deleting rows: two halves, and only one of them was written down

Migrations apply with `foreign_keys = OFF` (issue #95). That is deliberate and
stays: SQLite's own table-rebuild recipe (create → copy → drop → rename) fires
`ON DELETE CASCADE` on the drop if enforcement is on, which would wipe the
children of any table being rebuilt. The consequence nobody had written down
(#2680) is that **a migration's `DELETE` triggers no foreign-key action at all**.

So a row-deleting migration owes its neighbours two _different_ things:

| Inbound link                     | Runtime does       | A migration must             |
| -------------------------------- | ------------------ | ---------------------------- |
| `ON DELETE NO ACTION` (default)  | refuses the delete | **block** — skip the row     |
| `ON DELETE CASCADE` / `SET NULL` | removes / nulls it | **clean up** — do it by hand |

- The **blocking** half is the `CHILD_LINKS` registry each row-deleting migration
  declares: `{ table, column }` pairs probed with `PRAGMA table_info`, so a row a
  child still references is skipped. A pair naming a column that has never
  existed drops out of that probe silently and guards nothing — that is #2444,
  and `lib/__db_tests__/migration-child-links.test.ts` checks every declared pair
  against the final migrated schema. **`CHILD_LINKS` covers this half only.** Its
  silence about the other one is not coverage.
- The **cleanup** half is `lib/migrations/cascade-delete.ts`. Call
  `deleteRowsWithCascade(db, table, ids)` instead of a bare `DELETE FROM table`
  and the migration leaves the same graph behind that the app's own delete path
  would. Its links are read out of `PRAGMA foreign_key_list` **at apply time**,
  never transcribed: nothing is spelled twice so a #2444 typo is impossible, and
  apply time is the correct moment — when migration N runs on a fresh database
  the FK graph is the graph as of N, and the child tables a later migration adds
  must not be considered. This does not breach the determinism rule above; the
  helper reads only the database, which is exactly what that rule permits.

The same test file pins the cascading children of `medical_records` beside the
non-cascading parents, and fails a new migration that deletes from a table with
cascading children without routing through the helper. Migrations 092, 101, 118,
180 and `20260813-bmi-derived-rows` are frozen entries on that list, each with
its reason; migration 118 is the one that got it right by hand, long before there
was a helper. `20260813-cascade-orphan-sweep` clears the orphans the others left
— every row whose CASCADE parent is missing. `SET NULL` links are deliberately
not swept: nulling a column on a _surviving_ row rewrites live data
(`intake_item_logs.notify_message_id` is provenance a feature reads), which is a
bigger claim than removing a row the schema says cannot exist.

A missing CASCADE parent is **not** the only state `PRAGMA foreign_key_check`
reports. That pragma flags any dangling non-null reference whatever its
`ON DELETE` clause, so the `SET NULL` danglers above are reported before the
sweep and still reported after it. The sweep clears one _kind_ of violation, and
a future integrity probe over that pragma has to reckon with the rest before it
can mean anything — which is why turning `foreign_key_check` into a health-endpoint
reason is a separate decision, not a corollary of this one.

The sweep is a boot-time delete of health-record rows, taken with no backup
beforehand and no undo, so it **logs what it removed**: one `migrate`-scoped line
per run, `warn` with the per-link tally when rows went and `info` when none did.
The empty line is not noise — "this ran and found nothing" is the other half of
the forensic trail, and the migration runs exactly once per database.

**What the ratchet does not see.** It reads `DELETE` statements. Per statement,
not per file, and fail-closed: a `DELETE FROM` whose table it cannot resolve to a
literal identifier is a violation rather than a skip, because a delete it cannot
read is not a delete it may ignore. What it cannot see is the other way to lose
rows — a table **rebuild** that copies a filtered subset into `<t>_new`, which
orphans children identically with no `DELETE` token anywhere. That stays out of
scope here, for a reason worth stating rather than discovering: no lexical rule
is complete over that class. Sniffing for a `WHERE` in the copying `SELECT` would
catch two spellings and miss `INSERT INTO t_new SELECT * FROM t` followed by a
filtering delete on the new table (which has no inbound foreign keys, so the
`DELETE` guard is blind to it) — and a guard that catches some spellings while
reading like a guard is the #2444 defect, not a defence against it. The
population is also one: of the 32 shipped migrations using the rebuild recipe,
exactly one (083) filters rows, and `metric_samples` has no cascading children,
so the historical exposure is zero.

### The other half of the ratchet is behavioural (#2703)

A rule that cannot be written lexically can still be checked by running the
thing. After each migration it applies, `runMigrations` takes
`PRAGMA foreign_key_check`, compares it to the tally from before that migration,
and logs a `warn` naming any migration that **added** a dangling reference —
`reportOrphansIntroduced` in `lib/migrations/runner.ts`, over
`foreignKeyViolationTally` / `introducedViolations` in
`lib/migrations/cascade-delete.ts`. It sees the effect rather than the syntax, so
a filtering rebuild, a CTAS, a delete on the new table and a plain
`DELETE FROM parent` all answer the same way, and nothing is spelled twice so
nothing can be misspelled.

Three properties are the design, not details:

- **A delta, not an assertion of cleanliness.** The pragma reports every dangling
  non-null reference, including the `SET NULL` danglers this project keeps on
  purpose. A probe that flagged those would be complaining about the default
  posture on every boot forever — the standing-alarm shape ruled out for the
  health endpoint, and no better here. Only growth is reported.
- **A report, never a refusal.** The rows are dead weight, not corruption: every
  current reader joins the parent. Refusing the boot would trade a quiet
  inconsistency for an install that will not start, and it is the wrong moment
  anyway — the migration's own transaction has already committed, so a throw
  leaves the database half-upgraded instead of undoing anything. The repair is a
  forward migration calling `sweepOrphanedCascadeRows()`, exactly as
  `20260813-cascade-orphan-sweep` did for the #2680 orphans.
- **It costs what the data costs.** `foreign_key_check` is O(rows): 0.23 ms on the
  empty migrated schema, ~1 ms at 2.6k rows (`npm run seed`), ~50 ms at 500k. A
  fresh install replays all 190 migrations against a database with no rows (worst
  single check anywhere in the sequence: 0.45 ms; whole-boot cost inside
  measurement noise). An established install applies only the migrations its
  release added, so it pays one check per new migration on its real data. The
  baseline is taken lazily, so a boot with nothing to apply pays nothing at all.

The trade this accepts is that it does **not** fail CI: a fresh test database has
no rows to orphan, which is exactly why this class needed a probe that lives
outside CI in the first place. It fires wherever a migration meets data — an
operator's install, and a developer's own seeded database, which is where a new
migration is first run against rows. The per-statement source scan above is
retained unchanged; the two guards overlap on `DELETE` and neither subsumes the
other, one failing the build before the mistake ships and one catching the shapes
no scanner can read.

The alternative sketched in #2703 — a per-migration behavioural harness running
each of the 190 migrations against a fixture carrying a cascading child — was
measured and rejected. The fixture is the expensive part, not the run: 13 of 117
tables have inbound cascade/`SET NULL` links, and seeding a parent-and-child pair
for them means populating 48 tables with 149 no-default `NOT NULL` columns, 42
`CHECK` constraints and 21 further FK parents — at each of 190 historical schema
shapes, which the 32 rebuild migrations keep changing underneath it. A generic
seeder would silently fail to insert most of that at most points in the sequence
and the harness would then read as total while covering nothing, which is the
#2444 defect the guard exists to avoid. Resident fixture rows would also collide
with the data migrations that legitimately delete and re-home rows (177, 180,
185), turning correct behaviour into failures.

### Downgrade guard

If `user_version > MIGRATIONS.length` (a rolled-back image booting against a
newer DB), **fail the boot** with a clear error naming both versions and
pointing at `scripts/restore.ts`. Today this scenario silently "works" until the
old code hits a shape it doesn't know; failing fast is a deliberate behavior
change and gets a release-note line. No env escape hatch — an operator who
genuinely wants to run old code restores the matching backup.

### What stays outside the runner (per-boot tasks)

`migrate()`'s current tail is not schema migration and keeps running on every
boot, after the runner, in a `bootTasks(db)` step:

- `bootstrapAuth()` — env-dependent (`ADMIN_USERNAME`/`ADMIN_PASSWORD`), creates
  the bootstrap admin/profile only when missing.
- `reconcileFlagsIfCanonicalChanged()` — gated on the
  `canonical-flags-version.ts` content signature, not schema version; ranges can
  change in a release with no schema change.
- Stuck-state cleanup (`medical_documents.extraction_status`,
  `import_jobs.status`) — must run on **every** process start by design.
- `seedTimezoneFromEnv()` — env-dependent first-boot seeding.

`backfillProfileIds()` is the one judgment call: it is also a resurrection guard
tied to live inserts (#deleted-profile-1 rules), so it stays a boot task rather
than being frozen into baseline. Document this in the code.

### What changes for contributors (AGENTS.md update ships in the same PR)

| Change class       | Today                                           | After                                           |
| ------------------ | ----------------------------------------------- | ----------------------------------------------- |
| New table          | add CREATE block                                | append migration with the CREATE                |
| New column         | `addColumnIfMissing()` (+ registry side effect) | append migration: `ALTER TABLE … ADD COLUMN`    |
| Grow an enum CHECK | edit CREATE block **and** `ENUM_CHECKS` entry   | append migration: rebuild table with new CHECK  |
| One-shot data move | invent a settings flag                          | append migration (runs exactly once by version) |
| Table/key rebuild  | boot-time shape probe + rebuild helper          | append migration                                |

The CREATE blocks in baseline are **frozen**: a new column is _not_ added to the
historical CREATE. The current schema is no longer readable from one place in
source; `npm run schema:dump` (new tiny script printing `sqlite_master` from a
scratch in-memory DB after all migrations) fills that gap for humans, and tests
assert against the same dump.

### Test plan

Existing tiers keep their roles; the DB tier gets stronger and simpler:

- **`lib/__db_tests__/runner.test.ts`** (new): fresh in-memory DB → run all →
  `user_version === MIGRATIONS.length`; ids are contiguous and match array
  position; re-running is a total no-op; a DB stamped at version N only receives
  N+1…; `user_version` ahead of code fails with the downgrade error.
- **Immutability guard** (new, pure tier): recompute sha-256 of each
  `versions/*.ts` and compare to `manifest.json`. A hash mismatch fails CI with
  "shipped migrations are append-only — add a new migration instead". Adding a
  file requires adding its hash line (same diff), so review sees both.
  Baseline's hash is pinned like any other.
- **Upgrade-path test**: `lib/__db_tests__/migrate.test.ts`'s "strip
  `ADDITIVE_COLUMNS`, re-run" reconstruction becomes obsolete for the
  post-runner era — the real old schema **is** "replay migrations 1…N". Keep the
  existing reconstruction test for baseline itself (it guards the frozen era),
  and add: build DB at version N, assert migrations N+1… apply cleanly, for each
  N ≥ 1.
- **Schema-equivalence is by construction** (single path), so no fresh-vs-
  upgraded diff test is needed — this is the property that made the old
  reconstruction test necessary.
- The enum-check drift test and `ENUM_CHECKS` registry remain, scoped to the
  frozen baseline CREATEs; a lint-style pure test asserts no _new_ callers of
  `addColumnIfMissing`/`ENUM_CHECKS` entries appear outside `001-baseline.ts`
  (mechanism closed, not removed).

### Rollout

Single PR, no data risk (baseline is byte-for-byte today's `migrate()`):

1. Introduce `runner.ts` + `versions/001-baseline.ts` (move, don't rewrite, the
   `migrate()` body) + `manifest.json` + the new tests. `lib/db.ts`'s
   `createDb()` calls `runMigrations(db)` then `bootTasks(db)`.
2. Existing deployed DBs are at `user_version = 0` → they run baseline once
   (identical to every boot they already do) and get stamped to 1. Fresh DBs are
   identical. **No observable behavior change** except the stamp and the
   downgrade guard.
3. Update AGENTS.md ("Architecture → lib/db.ts" and the change-class table
   above) and the PR-template checklist line if needed. README is unaffected (no
   user-visible change).
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
- **Rollback UX regression** (downgrade guard fails fast where today it limps) —
  intentional, but needs a clear error message and a line in the deploy docs.
