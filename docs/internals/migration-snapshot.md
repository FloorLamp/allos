# The pre-flight migration snapshot

**Status:** shipped (#2702)

`runMigrations` copies the database aside before it applies a pending migration
set. This is the runner-level answer to a question #2696 deliberately left out of
its scope: a migration that **fails** loses nothing, but a migration that
**succeeds** and deleted the wrong rows cannot be undone.

- `lib/migrations/snapshot-policy.ts` — pure: when, what it is called, retention,
  headroom. Unit-tested in `lib/__tests__/migration-snapshot-policy.test.ts`.
- `lib/migrations/snapshot.ts` — the `fs` + `VACUUM INTO` side, the boot log, and
  the refusal. Driven through the real runner in
  `lib/__db_tests__/migration-snapshot.test.ts`.
- Operator-facing instructions live in [`docs/backups.md`](../backups.md).

## Why it exists

Three facts, established separately, meet here:

1. **A boot-time delete has no witness.** `createDb()` ran `runMigrations` with no
   snapshot taken first, so a migration that removed rows removed them before
   anyone could look.
2. **A failed migration is already safe.** The adversarial lane on #2696 proved a
   mid-migration throw rolls back cleanly — savepoint plus transaction, the pragma
   restored in `finally`, no ledger row written. The exposure is specifically the
   _successful_ migration whose deletions were wrong.
3. **It has already happened.** #2699 open question 6 records rows deleted by
   `20260813-bmi-derived-rows` under looser matching that **cannot be
   resurrected**. No tombstone, no copy, so no corrective migration is possible.

#2696 closed the _auditability_ half — the cascade sweep logs its per-link tally,
so an operator can learn _what_ was removed. This is the other half of the same
sentence: a boot-time deletion of health records with no undo has to leave a
record of what it took, **and** something to take it back from.

## The trigger: an upgrade is happening

The snapshot is taken when the pending set is **non-empty**, not when a pending
migration is believed to delete rows. Four alternatives were considered:

| Option                                 | Why not                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A declaration on the migration         | This repository's whole incident record is forgotten and misspelled declarations. #2444's `CHILD_LINKS` named three columns that have never existed, so it covered nothing while still reading like a guard.                     |
| A lexical scan of the migration source | #2703: a rebuild that copies a filtered subset into `<t>_new` removes rows with **no `DELETE` token**, and no lexical rule is complete over that class. It is also unavailable at runtime — the image ships compiled migrations. |
| A behavioural check                    | How #2703 was actually resolved (`PRAGMA foreign_key_check` before/after each migration) — but a **pre-flight** snapshot cannot be behavioural. The evidence a delete happened only exists after the delete.                     |
| A dry run against a throwaway copy     | The copy **is** the snapshot, so the disk cost is paid anyway, and the migrations run twice.                                                                                                                                     |

So the trigger asks a question the runner already answers exactly and cannot get
wrong. A new migration inherits the protection with nothing to declare, spell
correctly, or remember.

### What it costs when the trigger is wrong

**A delete that was not detected** cannot happen for a delete performed _by a
migration_: if a migration runs at all, the pending set was non-empty, so a
snapshot was attempted. The residual gap is a delete performed by a **boot task**
(`lib/migrations/boot-tasks.ts` runs after the runner, outside the ledger) or by
the app at runtime. Neither is in scope here, and neither is a silent boot-time
schema change.

**A snapshot taken needlessly** does happen: an upgrade whose migrations only add
a column still pays for one copy. That is the price of an unforgettable trigger,
and it is bounded on both sides — by the four skips below, and by the retention
policy.

### The skips

| Skip              | When                               | Why                                                                                                                                                                                         |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nothing-pending` | every boot after the first         | The dominant case. Costs one set difference the runner already computed.                                                                                                                    |
| `fresh-install`   | the ledger is empty                | An empty ledger means an empty database. The numbered-era backfill runs first, so a pre-ledger install arrives with names, not zero. Applying 190 migrations to no rows can delete nothing. |
| `in-memory`       | `:memory:` or an anonymous temp DB | No file to copy, and no operator to recover it.                                                                                                                                             |
| `disabled`        | `ALLOS_MIGRATION_SNAPSHOT=off`     | The operator took the decision. Logged as a warning when something _was_ pending.                                                                                                           |

## What is copied

`VACUUM INTO`, the same call `performBackup` makes. The alternatives fail for
concrete reasons rather than stylistic ones:

- A **plain file copy** of `allos.db` is wrong under WAL. The `-wal` holds
  committed transactions that have not been checkpointed, so a copy of the main
  file alone silently loses them, and copying the three files separately from a
  live connection can tear.
- SQLite's **online backup API** (`db.backup()` in better-sqlite3) returns a
  Promise. `createDb()` and `runMigrations` are strictly synchronous, so it cannot
  be awaited here.
- `VACUUM INTO` is synchronous, transactionally consistent against the open
  connection, writes one compact file, and **preserves `user_version`** — which
  the restore version gate reads.

Uploaded medical files are **not** copied. They live outside the database and a
migration cannot delete them.

## Where it lives

`<the database's own directory>/backups/pre-migration`, i.e.
`data/backups/pre-migration` in a normal Docker deployment. Derived from the
database path rather than `process.cwd()` so that an `ALLOS_DB_PATH` redirect
takes the snapshot with it. Override with `ALLOS_MIGRATION_SNAPSHOT_DIR`.

It is a subdirectory of the existing backups tree, which `listBackupNames`
(a `.db` **file** filter) cannot see, so the scheduled-snapshot rotation planner
never considers these files and `getLastBackup` can never report one as "the last
backup". Filenames are `allos-premigrate-YYYY-MM-DD-HHmmss.db` (UTC): they start
`allos-` and end `.db` so `npm run restore -- --from <dir>` lists them, and they
do **not** match `parseBackupStamp`'s scheduled-snapshot shape, so nothing else
touches them.

It is on the bind-mounted volume, competing with the database for the same space
(#1856). That is deliberate. An off-volume destination (`BACKUP_DEST_DIR`) may
legitimately be an unmounted mount point at boot — the #463 readiness gate exists
for exactly that — and a boot that stalls on a NAS is a worse failure than a copy
on the same disk. The headroom pre-check and the refusal below are what make the
same-volume default honest.

## The refusal

A snapshot that cannot be taken **throws**, and the boot stops with nothing
applied. Two clauses reach it before any bytes are written (an unwritable
directory, insufficient free space against the same `BACKUP_SNAPSHOT_HEADROOM_FACTOR`
the health endpoint's `disk-low` uses) and two after (`VACUUM INTO` failed, or the
copy failed `PRAGMA integrity_check` — which means the _live_ database is damaged
and should not be migrated).

Refusing is right **here and nowhere else in this runner**, because the costs are
asymmetric and the moment is unique:

- Refusing costs an outage the operator ends by freeing space, and it is
  perfectly reversible — no migration has run, `user_version` and the ledger are
  untouched, and the **previous image still boots this database unchanged**.
- Proceeding risks a delete with no copy behind it, which is not reversible at
  all.

Contrast `reportOrphansIntroduced` in the same file, which deliberately reports
rather than throws: by the time it runs, the migration's transaction has already
committed, so a throw there would leave the database half-upgraded. Here nothing
has been applied, which is exactly what makes the refusal safe to take.

Every refusal names what failed, the pending migrations it was protecting, and
`ALLOS_MIGRATION_SNAPSHOT=off` — so proceeding without a copy is a decision
someone made, never a silence. **The operator can always tell which happened**:
a refusal is a boot failure with that message; a successful snapshot is one
`INFO [migrate]` line naming the file; an opted-out upgrade is one
`WARN [migrate]` line saying so.

## Discovery

A snapshot nobody can find is not a recovery path. Three surfaces:

1. **The boot log** — one `INFO [migrate]` line naming the file, its size, the
   pending migrations, and the exact `npm run restore -- --from …` command.
2. **The metadata sidecar** — `<snapshot>.migration.json`, recording `takenAt`,
   `fromUserVersion`, `appliedCount`, the `pending` names, and `bytes`. An
   operator who finds the directory months later can tell which upgrade each file
   precedes without opening it.
3. **The verification sidecar** — `<snapshot>.json`, the same
   `BackupVerification` shape `verifySnapshot` writes. This one is **load-bearing
   for restore**: `restoreCore` refuses a snapshot it cannot verify unless
   `--force` is passed, so a pre-migration snapshot without it would be a safety
   net the restore path rejects.

## Restoring one

The snapshot's `user_version` is the applied count **before** the pending set, so
it is always lower than the running build's migration count and the #472 version
gate (`decideSnapshotVersion`, which only refuses a snapshot _newer_ than the
build) accepts it.

That gate passing is not the whole story, and the caveat matters:

> **Restoring under the same image re-applies the same migrations.** The runner is
> ledger-driven, so a restored pre-migration database has the same pending set it
> had before — including the migration whose deletions were wrong.

Three recovery shapes, in the order they are usually wanted:

1. **Extract the rows without downgrading.** The snapshot is an ordinary SQLite
   file; open it read-only (`sqlite3 data/backups/pre-migration/allos-premigrate-….db`)
   and copy out what the migration removed. Nothing is taken offline and the live
   database keeps every later write.
2. **Roll back the image and restore.** Stop the container, restore the snapshot
   with `npm run restore -- --from data/backups/pre-migration <name>`, and pin
   `IMAGE` to the previous tag so the offending migration is not in that build's
   registry. Writes made after the upgrade are lost.
3. **Restore and fix forward.** Restore the snapshot, then ship a corrected
   migration. Shipped migrations are hash-locked, so the correction is a _new_
   migration and the bad one must be neutralised in the same build — this is the
   heaviest option and only worth it when the deletion is large.

## Retention

Two clauses, either of which prunes: beyond the newest
`MIGRATION_SNAPSHOT_KEEP` (2), or older than `MIGRATION_SNAPSHOT_MAX_AGE_DAYS`
(30). Two, not one, because an upgrade that runs twice in quick succession
(a rolled-forward hotfix) must not evict the copy protecting the upgrade before
it, which is the one most likely to be wrong.

The age clause applies to the newest file too, so a directory on an instance that
has stopped upgrading eventually empties. This is a **recovery copy for a bad
upgrade, not an archive** — the ordinary keep-N-dailies + M-weeklies snapshots
cover the same data on a long horizon, and a pre-migration copy's unique value is
"the state immediately before _this_ upgrade", worth the most in the days after it
and approximately nothing a year later while still costing a whole database on
the bind mount.

Who deletes them:

- **The runner**, immediately before it writes a new one, at `keep - 1` so the new
  file lands inside the retention. This is the opposite order from `performBackup`
  (which prunes only _after_ a verified snapshot so a corrupt new file cannot
  rotate away good ones) and the reasoning differs: the older pre-migration copies
  protect upgrades that already completed and were lived with, and the space they
  occupy is the space the new copy needs. Freeing it first is what stops a
  full-disk refusal from being caused by our own files.
- **The scheduled backup tick**, through the same pure plan, which is what applies
  the age cap on an instance that has stopped upgrading.

## Crash loops

A migration that throws on every boot leaves the pending set unchanged, so without
a guard the runner would `VACUUM` the whole database again on every restart.
`matchesPreState` compares the newest snapshot's metadata — `fromUserVersion`,
`appliedCount`, and the exact ordered `pending` list — against the state about to
be migrated, and reuses the existing file when they agree. That is safe precisely
_because_ the migrations did not apply: `createDb()` rethrows, so the app never
served a request and nothing wrote to the database between the two boots. A
**partial** application moves `appliedCount` and shortens `pending`, so the next
boot correctly takes a fresh copy.

## What this does not do

- It does not build a restore UI or an operator CLI. `npm run restore --from`
  already installs these files.
- It does not copy uploads.
- It does not snapshot before **boot tasks**, which run outside the versioned
  runner.
- It does not tell you _what_ a migration removed. That is #2696's per-link tally
  and the runner's `foreign_key_check` delta; this is the copy you compare against.
