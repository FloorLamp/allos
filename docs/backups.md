# Backups

Configure backups in **Settings → Server → Automated backups** (admin only).
The [README](../README.md#data-and-backups) gives the short operator overview.
Paths below are inside the app; Docker mounts the host's `DATA_DIR` at `/app/data`.

## Scheduled snapshots

The notify tick takes a nightly SQLite snapshot using `VACUUM INTO`, which is
safe against the live connection. Choose the backup hour in the instance timezone,
retention (default **7 daily + 8 weekly** snapshots), and stale alarm (default
**48 hours**). The card shows the last verified backup, errors, and **Back up now**.

Snapshots are `data/backups/allos-<YYYY-MM-DD-HHmm>.db`. Each is opened read-only
for `PRAGMA integrity_check`, with the result in `<name>.db.json`. Failed copies
remain available for diagnosis but do not count as successful backups or retention
keepers. Older copies are pruned only after a new snapshot passes verification;
failed or unverified files cannot displace verified keepers.

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

The mirror excludes `data/integration-payloads/` (raw provider payloads) and
`data/logs/ai.jsonl` (AI audit log). Copy these separately if needed. The destination
holds multi-profile health data; Allos does not provision a cloud or network target.

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

The tool verifies the snapshot, copies the current database and its `-wal`/`-shm`
files aside as `allos.db.pre-restore-<timestamp>`, installs the snapshot by atomic
rename, and clears stale WAL sidecars. The backup tick retains the newest three
restore asides.

Restoring prompts for confirmation; append `--yes` to skip that prompt. `--force`
overrides refusals for a detected live connection, failed integrity, or a snapshot
schema newer than the running build. It does not make a newer schema compatible
with an older image.

Restore uploads as well when recovering from a mirror; database rows alone cannot
recover medical files. The tool prints an uploads-copy command when the source has
an uploads directory, for example:

```bash
cp -a /backup/uploads/. data/uploads/
```

## Pre-migration snapshots

Before applying pending migrations to an existing database, startup takes a
separate snapshot under `data/backups/pre-migration/`:
`allos-premigrate-<YYYY-MM-DD-HHmmss>.db` (UTC). Nothing is copied on an ordinary
boot with no pending migrations or on a fresh install. Repeated failed boots can
reuse a verified snapshot of the same pre-migration state.

These copies have independent retention: **two snapshots, at most 30 days old**.
Each has an integrity sidecar (`<name>.db.json`) and migration metadata
(`<name>.db.migration.json`). The boot log gives its path, size, and restore command.

If the copy cannot be made, startup stops before applying pending migrations.
Free space or select another destination, then retry. Operators with another
backup method can opt out:

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
