# Backups

Configure backups in **Settings → Server → Automated backups** (admin only).
The [README](../README.md#data-and-backups) gives the short operator overview.
Paths below are inside the app; Docker mounts the host's `DATA_DIR` at `/app/data`.

## Scheduled snapshots

The notify tick snapshots SQLite nightly with `VACUUM INTO`, safe against the live
connection. Configure the instance-local backup hour, retention (default **7 daily + 8 weekly**), and stale alarm (**48 hours**). The card
shows verification, errors, and **Back up now**.

Snapshots are `data/backups/allos-<YYYY-MM-DD-HHmm>.db`, verified read-only with
`PRAGMA integrity_check`; `<name>.db.json` records the result. Failed copies stay
for diagnosis but cannot displace verified retention keepers. Pruning follows
successful verification.

The tick also checks the live database weekly and caches its integrity verdict.
A failed verdict makes [health](#health-endpoint) degraded and triggers another
check each tick until it passes. **Recheck integrity now** runs it immediately,
including after a repair outside the restore tool.

Snapshots contain every profile's data and are never served by an app route.
They contain **only the database**. Losing the default data volume also loses its
snapshots; uploaded medical files live separately in `data/uploads/`. Use an
[off-volume destination](#off-volume-backups-backup_dest_dir) or a stopped-app copy
of the [whole data directory](#moving-to-a-new-server).

## Scheduling without the notify sidecar

If the notify sidecar is absent, run the standalone entrypoint hourly. It uses
the same schedule, retention, and verification:

```cron
0 * * * * cd /app && npm run backup
```

`npm run backup -- now` takes a verified snapshot immediately, regardless of the
schedule. Backup or verification failures exit nonzero.

## Off-volume backups (`BACKUP_DEST_DIR`)

Mount a second disk, NAS, or other operator-controlled directory and set
`BACKUP_DEST_DIR` to its path inside the container:

```yaml
# Add to the app's docker-compose service:
volumes:
  - "${DATA_DIR:-./data}:/app/data"
  - "/mnt/nas/allos-backup:/backup"
environment:
  BACKUP_DEST_DIR: /backup
```

After mounting it, click **Verify destination** on the backups card. This writes
`.allos-backup-destination` into the mounted directory. Replication requires that
existing directory and sentinel; it never creates the destination root. A missing
mount or sentinel skips replication and records `backup_offsite_last_error`.

After each verified snapshot, Allos copies the database and verification sidecar,
uses the same retention at the destination, and incrementally mirrors uploads to
`BACKUP_DEST_DIR/uploads/`. The card shows destination readiness, last copy, and
errors. Replication failures do not fail the primary snapshot; an overdue replica
can produce `offsite-stale` health status.

The mirror excludes raw provider payloads (`data/integration-payloads/`) and the AI
audit log (`data/logs/ai.jsonl`); copy them separately if needed. The destination
contains multi-profile health data and must be operator-provided.

Uploads are append-only for ordinary row deletions. **Deleting a profile** instead
best-effort removes that person's medical files locally and from the mounted,
verified mirror. Database snapshots retain older records until retention removes
them.

## Restore

**Stop the app before restoring.** Live-connection detection is best-effort and
can miss an idle WAL connection. Use the restore tool to list snapshots with their
integrity status and schema version, then choose one:

```bash
npm run restore
npm run restore -- allos-<stamp>.db

# List or restore from a mirror:
npm run restore -- --from /backup
npm run restore -- --from /backup allos-<stamp>.db
npm run restore -- --from                     # use BACKUP_DEST_DIR
```

The tool verifies integrity/schema, preserves the old DB and WAL/SHM as
`allos.db.pre-restore-<timestamp>`, atomically installs the snapshot, then clears
stale WAL sidecars. The backup tick keeps three restore asides.

`--yes` skips confirmation. `--force` overrides detected live connections, failed
integrity and newer-schema refusals; it cannot make an incompatible schema usable.

Restore uploads too: rows cannot recover files. When available, the tool prints
the uploads-copy command:

```bash
cp -a /backup/uploads/. data/uploads/
```

## Pre-migration snapshots

Before applying pending migrations to an existing database, startup takes a
separate snapshot under `data/backups/pre-migration/`:
`allos-premigrate-<YYYY-MM-DD-HHmmss>.db` (UTC). Nothing is copied on an ordinary
boot with no pending migrations or on a fresh install. Repeated failed boots can
reuse a verified snapshot of the same pre-migration state.

These copies retain **two snapshots, at most 30 days old**, with integrity
(`<name>.db.json`) and migration (`<name>.db.migration.json`) sidecars. The boot log
gives the restore command. Copy failure stops startup before migrations; free space
or change destinations. Operators with another backup method can opt out:

```dotenv
ALLOS_MIGRATION_SNAPSHOT_DIR=/backup/premigrate
ALLOS_MIGRATION_SNAPSHOT=off:20260814-some-slug  # one pending migration's upgrade
ALLOS_MIGRATION_SNAPSHOT=off                   # every upgrade
```

Choose one opt-out form. Prefer the scoped form using a pending migration name
printed by the refusal: it stops disabling snapshots once that migration has run.
An unknown name or empty `off:` disables nothing. Upgrade logs report the opt-out
or its expiry; ordinary boots stay quiet. The directory override is independent
of the nightly `BACKUP_DEST_DIR` mirror.

Use the [restore procedure](#restore) with this source directory:

```bash
npm run restore -- --from data/backups/pre-migration
npm run restore -- --from data/backups/pre-migration allos-premigrate-<stamp>.db
```

**The same image will reapply the same migrations after restoration.** Pin `IMAGE`
to the previous tag before restoring, or leave the live database alone and inspect
individual records in the snapshot read-only:

```bash
sqlite3 -readonly data/backups/pre-migration/allos-premigrate-<stamp>.db
```

## Deployment and backup gates

`deploy/liftoff.json` declares SQLite, uploads, provider payloads and logs. An
AI-enabled host supplies `ANTHROPIC_API_KEY` through its scoped provider; missing credentials disable AI.
The image bundles `node /app/dist/restore-check.cjs /app/data`: the existing restore
core verifies schema/integrity; normal startup migrates a disposable DB; profile
export readers verify records and original files. Missing uploads, corruption or
an incompatible schema fail the gate. Checkpoint inputs and live data stay untouched.
The host owns encrypted off-host copies and retention; passing this gate does not
provide that copy.

## Moving to a new server

Stop the old app, then copy the **whole `DATA_DIR`**, including database/WAL files,
`uploads/`, `integration-payloads/`, and `backups/`:

```bash
rsync -a "$DATA_DIR"/ newhost:/path/to/allos-data/
```

Point the new host's `DATA_DIR` at that copy and start the app. Keep the old app
stopped during the copy so files cannot change underneath it. **Export all my data**
is a portability ZIP; it omits operational state such as connections, sessions,
and sync history and cannot rebuild an instance.

## Health endpoint

`GET /api/health` returns `{ ok, status, reason?, lastBackupAgeHours }` with HTTP
200 for `status: "ok"` or **503** for `status: "degraded"`. The container healthcheck
uses this response. It reports the first applicable reason in this order:

| Reason              | Condition                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `db-failed`         | Database read fails.                                                                                               |
| `write-failed`      | Writing to `data/` fails.                                                                                          |
| `integrity-failed`  | Cached live-database integrity verdict failed.                                                                     |
| `disk-low`          | Free space is below the percentage floor, or below snapshot headroom when backups are enabled.                     |
| `backup-stale`      | Backups are enabled and the last successful snapshot exceeds the stale alarm.                                      |
| `backups-never-ran` | Backups are enabled, none succeeded, and instance age exceeds the **72-hour** grace period.                        |
| `offsite-stale`     | Backups are enabled, `BACKUP_DEST_DIR` is configured, and a previously successful replica exceeds the stale alarm. |

The disk floor defaults to **5%**. `ALLOS_DISK_FREE_FLOOR_PERCENT` accepts 0–50;
`0` disables only the percentage check. Snapshot headroom requires **1.2× the live
database size** free and is not configurable. Freeing space clears `disk-low` on
the next poll; unavailable disk measurements skip their checks.

The primary and replica stale alarms share the configured threshold (default
48 hours). A mirror that has never succeeded reports its error on the backups card
instead of `offsite-stale`. Disabling backups suppresses all three backup alarms.

The endpoint reads the cached integrity verdict; it does not run `integrity_check`.
Its unauthenticated response excludes paths, versions, storage sizes, and health
records. `lastBackupAgeHours` is null when no backup has succeeded. Notification
channel failures are shown in Settings separately; see [notifications](notifications.md).
