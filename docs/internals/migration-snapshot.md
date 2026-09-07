# Pre-migration snapshots

`runMigrations` takes a recoverable database copy before applying a pending
upgrade. A failed migration rolls back its own transaction; a successful but
incorrect deletion needs data from before it ran. The snapshot protects that
recovery path without requiring every migration to declare whether it deletes.

`lib/migrations/snapshot-policy.ts` owns selection, names, retention, and
headroom. `snapshot.ts` performs the synchronous copy and verification using the
handle supplied by the runner. It must not import `lib/db`, whose singleton is
still being created. See the [runner guide](../versioned-migrations-spec.md)
for ordering and transaction behavior, and [backups](../backups.md) for operator
commands and the wider recovery system.

## Trigger and placement

The decision uses the pending migration set. Do not narrow it to declared
deletes or a source scan: a filtering rebuild can remove rows without a delete
statement, and observing that effect after migration is too late for this copy.

| Skip              | Condition                                              |
| ----------------- | ------------------------------------------------------ |
| `nothing-pending` | No unapplied migration names                           |
| `fresh-install`   | Applied-name count is zero after numbered-era backfill |
| `in-memory`       | `:memory:` or an anonymous temporary database          |
| `disabled`        | The operator's opt-out applies                         |

The empty-ledger skip is the runner's fresh-install convention, not an
inspection of every table's contents. Numbered-era databases with a version
stamp receive their ledger backfill before this decision.

The snapshot runs after downgrade checks and ledger preparation, in autocommit,
before the foreign-key toggle and per-migration transactions. Keep it there.
It uses `VACUUM INTO` on the live handle, preserving committed WAL content and
`user_version` in one database file. Copying only the main file is not an
alternative. Uploaded files are outside this copy; ordinary backup mirroring
handles them separately.

## Location and artifacts

The default is `<database directory>/backups/pre-migration`, following
`ALLOS_DB_PATH` rather than the working directory. In a normal deployment this
is `data/backups/pre-migration`. `ALLOS_MIGRATION_SNAPSHOT_DIR` overrides it.
The default uses the database's volume; it is not protection against losing
that volume and does not depend on the scheduled backup destination being mounted.

Names are UTC `allos-premigrate-YYYY-MM-DD-HHmmss.db`, with a numeric suffix for
same-second copies. They are distinct from scheduled snapshot names and live
in a separate directory, so scheduled rotation and “last backup” reporting do
not mistake them for nightly backups.

A successful copy produces:

- The SQLite file.
- `<name>.migration.json`: time, prior version, applied count, ordered pending
  names, and byte size.
- `<name>.json`: the shared backup-verification result used by restore tooling.

The boot log names the file, size, pending migrations, and restore command.
Sidecar-write failures warn without discarding the copy. They can prevent
automatic reuse or normal restore acceptance, so a success log alone does not
prove every sidecar was written.

## Refusal and opt-out

An unusable directory, insufficient headroom, failed copy, or failed integrity
verification raises `MigrationSnapshotError` and stops boot before any pending
migration body runs. The runner may already have created/backfilled its ledger.
Do not describe this as a guarantee that the entire database is byte-unchanged.

Headroom includes the main DB and WAL sizes, multiplied by the shared
`BACKUP_SNAPSHOT_HEADROOM_FACTOR`. An unavailable free-space probe allows the
copy attempt; it does not prove sufficient space. Copy/verification failures
still refuse the upgrade. Diagnose the reported error before treating a failed
verification as proof of live-database corruption.

The refusal lists pending names and the scoped opt-out. Fixing the copy failure
retains the recovery path; opting out explicitly proceeds without it.

| `ALLOS_MIGRATION_SNAPSHOT` | Effect                                  |
| -------------------------- | --------------------------------------- |
| Unset or unrecognized      | Normal snapshot policy                  |
| `off`, `0`, `false`, `no`  | Disable all upgrades while set          |
| `off:<migration name>`     | Disable only while that name is pending |
| `off:` without a name      | Ignore the malformed value and warn     |

The off aliases also accept the scoped form. Matching a pending name is
case-insensitive. The scope applies to the whole pending set while its named
migration is in it; it is not consumed on first read. Once that migration applies,
a later upgrade is protected again. A scope naming nothing pending leaves the
snapshot enabled.

On relevant upgrade boots, permanent/scoped opt-outs warn, an expired scope
reports that it no longer applies, and malformed input warns. An ordinary boot
with no pending migrations stays silent.

## Retention and reuse

The policy keeps at most two snapshots and removes ones older than 30 days,
including the newest if it has aged out. The runner prunes **before** making a
new copy, keeping one existing snapshot to leave room. A later copy failure can
therefore occur after old snapshots have been pruned. Cleanup is best-effort
and only considers recognized pre-migration names and their sidecars.

The scheduled backup path runs the same pruning policy, applying age retention
even when no new upgrade occurs. Without that path running, elapsed time alone
does not delete files. Scheduled backup rotation remains separate.

To avoid repeated copies on a failed boot, the runner may reuse the newest
snapshot when its version, applied count, and ordered pending names match, its
verification sidecar says `ok`, and the file exists. This is a migration-state
comparison, not a content hash or a new integrity check. The design assumes no
intervening writes while startup keeps failing; do not generalize it into a
snapshot-validity check for a database that continued accepting writes.

A partially completed upgrade changes the applied count/pending set and takes
a new copy on the next attempt.

## Recovery and boot-task coverage

A compatible pre-migration snapshot passes the restore version check, subject
to verification. **Restoring under the same build runs the same pending
migrations again**, including the problematic one. A newly appended repair alone
cannot prevent an earlier immutable migration from executing first.

Use the [restore procedure](../backups.md): either inspect/extract needed records
from a read-only snapshot while preserving later live writes, or stop the app
and restore with a compatible build that does not repeat the offending change.
A full restore discards writes after the snapshot. Do not edit shipped migration
hashes or silently skip ledger entries as a recovery recipe. Upload recovery is
separate because this artifact contains only the database.

Boot tasks run after the runner on every startup and do not request their own
copy. During an upgrade, this snapshot can contain records a later task removes;
on ordinary boots there is no fresh pre-task copy. The existing boot-task delete
census records allowed row classes, with behavioral coverage for alias/state
carry-forward. It only scans its declared source scope, not arbitrary indirect
calls or every filtering rebuild. A new pass deleting user-entered records
without carrying them forward belongs in a migration.

## Verification

`migration-snapshot-policy.test.ts` covers the pure decisions.
`lib/__db_tests__/migration-snapshot.test.ts` drives real copying through the
runner and restore gate, including skips, opt-out expiry, refusal, reuse, and
a changed pending set. Use those owners when changing behavior; do not add a
second declaration registry or duplicate restore harness. Follow the
[change and test policy](../change-policy.md).
