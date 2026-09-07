# Migration runner and contributor guide

Status: Implemented. This guide describes the current migration runner.

The shipped runner is `lib/migrations/runner.ts`. Applied migration **names**
in `schema_migrations` determine what runs; `PRAGMA user_version` remains an
applied-count tripwire for downgrade and restore checks. `MIGRATIONS` in
`lib/migrations/versions/index.ts` is the ordering authority.

## Adding a migration

Follow [migration instructions](../lib/migrations/AGENTS.md) and the
[change and test policy](change-policy.md).

1. Add `lib/migrations/versions/YYYYMMDD-slug.ts`, exporting a synchronous
   `Migration` with a unique `name` and `up(db)`. New migrations have no `id`.
2. Append it last in `versions/index.ts`. Preserve merge order; do not sort by
   filename or reserve sequential numbers. When branches conflict, keep both
   migrations in the order they land.
3. Run `npm run gen:migration-manifest`. The generator adds SHA-256 entries and
   refuses changed or missing shipped files. Resolve manifest conflicts with
   the generator, never hand-written hashes.
4. Exercise the schema/data change with the relevant existing DB coverage,
   adding a focused historical fixture where the failure is not covered.
   Use `migrationsBefore(name)` for the prior schema rather than a numeric
   slice or a copied current schema.

Shipped migrations, including `001-baseline.ts`, are immutable. Migrations
001–185 are the closed numbered prefix; their IDs, names, and hashes stay fixed.
Names need not equal filenames in that historical prefix, so do not derive
one from the other.

Use `ALTER TABLE` for suitable additive columns and a table rebuild for a
changed CHECK or new foreign key. Resolve dangling links before enforcing a
new FK. A rebuild must preserve the intended data, indexes, constraints, and
child relationships. Follow the export-column requirements in the migration
instructions when adding columns; provenance belongs in the portable export.

Keep all migration effects on the supplied database handle. Do not import the
application DB singleton, read mutable application catalogs to decide historical
data, call the network, or write files from `up`. `runBootTx` can retry a body
after `SQLITE_BUSY`; effects outside that transaction would survive rollback.
See [migration re-entry](internals/migration-reentry.md).

Use `npm run schema:dump` to inspect the schema after the full migration chain.
Do not restore retired `ADDITIVE_COLUMNS`, `ENUM_CHECKS`, profile backfills, or
settings-flag migration mechanisms.

## Applied state and boot order

The runner validates unique names and the numbered-prefix ordering, ensures the
ledger exists, then checks for unknown applied names and an ahead-of-build
`user_version`. Either downgrade condition refuses boot. There is no downgrade
override: use a compatible backup/build or redeploy the newer image.

For a database from the numbered era, the runner backfills the first stamped
number of names, bounded by the numbered prefix. Their `applied_at` records the
backfill time, not the original migration time. The ledger remains authoritative.

Next, the runner computes pending names and invokes the
[pre-migration snapshot](internals/migration-snapshot.md) while in autocommit,
before disabling foreign keys or starting migration transactions. Ledger setup
and numbered-era backfill may already have occurred; “nothing applied” at a
snapshot refusal means none of the pending migration bodies ran.

Each pending migration runs in its own `BEGIN IMMEDIATE` transaction through
`runBootTx`. Inside that transaction it rechecks the ledger, executes `up`,
records the name, and advances `user_version`. The in-transaction recheck
prevents another boot worker from applying the same body twice. The pragma
never decreases: numbered entries retain their ID stamp, and name-keyed entries
increment beyond the numbered ceiling.

A throwing migration rolls back its own transaction and stops boot. Earlier
committed migrations remain applied; a retry resumes from the remaining names.
After each successful transaction, the runner reports newly introduced FK
violations. Those reports do not undo the committed migration or refuse boot.
The prior foreign-key setting is restored in `finally`.

A fresh database replays baseline and the full chain. Deployed databases follow
main's append order. A development database may already contain a branch
migration while missing an earlier merged entry; the runner tolerates that set
and applies the missing entry late. It does not reorder history already applied.

`createDb()` uses an advisory sidecar boot lock around migrations and boot tasks.
If that lock is unavailable, boot proceeds with the transaction guards and
bounded busy retries. The advisory lock is not the correctness boundary.

## Deleting rows and preserving links

Migration transactions run with foreign keys disabled to allow parent-table
rebuilds. Deletes therefore need explicit handling of incoming relationships:

| Incoming link | Migration responsibility                               |
| ------------- | ------------------------------------------------------ |
| NO ACTION     | Keep the parent while a child references it            |
| CASCADE       | Delete the corresponding child rows                    |
| SET NULL      | Clear the corresponding reference on the surviving row |

For the blocking case, declare `CHILD_LINKS` as literal `{ table, column }`
pairs and exercise each pair through the existing migration child-link fixture
registry. A declaration alone proves neither that the column exists nor that
the child prevents deletion. Retain an unreferenced parent as a positive control
for the deletion path.

For cleanup, use `deleteRowsWithCascade(db, table, ids)` from
`lib/migrations/cascade-delete.ts`. It reads the FK graph at application time,
so a fresh replay uses the schema that actually exists at that migration.
Do not transcribe a second list of cascading children.

`sweepOrphanedCascadeRows` repairs already-orphaned CASCADE children and logs a
per-link tally, including a no-op result. It deliberately does not null dangling
SET NULL references on surviving rows; those can carry live provenance and
need a separate repair decision.

The existing source checks cover explicit delete statements and declared child
links. They cannot prove preservation through every filtering rebuild. Do not
add another lexical approximation or a fixture generator for every historical
schema to claim that coverage.

## Foreign-key delta reporting

`foreignKeyViolationTally` and `introducedViolations` compare the database before
and after each migration, including changes made by rebuilds. Report newly
introduced dangling row identities, not all existing violations or merely net
count growth: repairing one orphan must not hide a different newly orphaned row.

Identity tracking falls back to counts for links over its 20,000-row cap and
rebuilt child tables, whose rowids may change. The pragma is streamed, and its
initial baseline is lazy so an ordinary boot with nothing pending pays no probe.
If a probe cannot run, report the gap once and retry the baseline for the next
migration. Missing evidence is not a clean result.

Warnings name the migration and affected links. A corrective migration may use
the cascade sweep only for relationships it actually handles. Fresh-schema
success alone cannot show that a migration preserves an established profile's
records; exercise meaningful populated data when changing a migration's effect.

## Per-boot work and compatibility

`bootTasks(db)` runs after migrations on every startup. It owns environment
bootstrap, current-catalog reconciliation, and interrupted-work recovery where
those must run without a schema change. Do not copy its evolving implementation
into this guide. One-shot data moves belong in migrations.

Boot tasks do not independently trigger a snapshot. An upgrade copy may contain
rows a later task deletes, but an ordinary startup has no fresh copy. Keep the
boot-task delete census and its behavioral carry-forward coverage current;
a new destructive one-shot pass belongs in the protected migration path.

Baseline is a clean apply of the schema at the runner's introduction, not a
compatibility ladder for older pre-runner releases. Such installations must
first pass through the last pre-runner release. Preserve the full immutable
chain; reconsider a schema bootstrap snapshot only if measured replay cost
justifies the additional upgrade/equivalence obligations.

## Verification

Use `runner.test.ts` for applied state, ordering, replay, and downgrade behavior;
`migration-reentry.test.ts` for transaction retry; and the migration's existing
data fixture for its effect. The immutability and child-link checks retain their
specific roles. Snapshot verification belongs to the linked snapshot guide.
Run relevant DB checks before broader validation; do not recreate the retired
proposal's configuration assertions or numeric-ID test plan.
