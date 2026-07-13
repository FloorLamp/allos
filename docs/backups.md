# Backups

Status: **shipped** · descriptive documentation of current behavior, extracted from the README (#597)

Snapshots, off-volume replication, restore, host migration, and the health endpoint. The README's [Backups](../README.md#backups) section is the short version.

The hourly tick takes a **nightly SQLite snapshot** of the database via
`VACUUM INTO` (a compact single-file copy, safe against the live connection).
Configure it in **Settings → Server → Automated backups** (admin only): enable/disable,
the hour (in the instance timezone), and retention (keep _N_ dailies + _M_ weeklies,
default 7/8). Snapshots are written to `data/backups/allos-<YYYY-MM-DD-HHmm>.db`, older
ones are pruned only after a successful new snapshot, and the card shows the last backup's
time/size (plus any failure) with a **Back up now** button. The card also shows the last
**live database integrity** verdict and a **Recheck integrity now** button.

**Integrity verification.** Each fresh snapshot is opened read-only and checked with
`PRAGMA integrity_check`; the result is written to a JSON sidecar next to it
(`allos-<stamp>.db.json`). A snapshot that **fails** the check is kept for forensics but is
**not** counted as a successful backup, is **never** counted as a retention keeper, and older
good snapshots are **not** pruned — so a corrupt (or partial, sidecar-less) copy never
occupies a keep slot, evicts a healthy one, or shows up as "the last backup" (the card and
`restore` always prefer the newest **verified** snapshot). The same tick also runs a
**weekly** `integrity_check` on the live database (gated by a stored marker), logging the
result loudly on failure **and caching the verdict** — a failed live check makes the health
endpoint report unhealthy (see [Health endpoint](#health-endpoint)) so the container
healthcheck flips. If you repair the database by any route **other** than restoring a snapshot
(e.g. `.recover`, or the failure was a transient glitch), the failed verdict re-runs every
tick until it passes — and **Recheck integrity now** re-tests it immediately so the health
endpoint recovers without waiting for the next weekly window.

Snapshots live under `DATA_DIR` (the Docker bind mount, outside the checkout) and are
**never served by any route** — they contain multi-profile health data.

### Off-volume backups (`BACKUP_DEST_DIR`)

> **Same-volume caveat:** by default snapshots land in `data/backups` — the **same** bind
> mount as the live database. A disk or volume loss destroys the database **and** every
> snapshot together, and uploaded medical files (`data/uploads/`) aren't in a snapshot at
> all. On-volume backups are not a durability story on their own.

Set **`BACKUP_DEST_DIR`** to a **second mounted directory** — a NAS, another disk, or a
synced folder the operator controls — and after each verified snapshot the app copies it
(and its `.json` verify sidecar) there, prunes that destination to the same retention, and
**mirrors `data/uploads/`** to `BACKUP_DEST_DIR/uploads`. The uploads mirror is incremental
and append-only: because uploaded files are content-hashed and immutable, only new files are
copied each night, so it stays cheap. Keep the destination **operator-controlled** — it holds
multi-profile PHI, so no cloud/network target is wired up (mount your own if you want one).

**Verify the mount (avoids silent evaporation).** The app **never creates the destination
root** — a missing mount must fail honestly, not `mkdir` a fake backup into the container's
ephemeral layer that vanishes on the next redeploy. So replication requires a one-time
**sentinel** (`.allos-backup-destination`) written into the mounted volume: after mounting
`BACKUP_DEST_DIR`, click **Verify destination** on the backups card. If the sentinel is
absent (never verified, or the volume later unmounted), replication is **skipped** and the
reason is recorded under `backup_offsite_last_error` — off-volume backups don't silently
succeed into nowhere.

The **Settings → Server → Automated backups** card shows whether `BACKUP_DEST_DIR` is
configured, whether the destination is currently **mounted and verified**, and the time of the
last off-volume copy (or its last error). Off-volume failures are recorded under their own
marker and never fail the primary snapshot, but an off-volume mirror that has gone **stale**
(older than the backup-staleness threshold, default 48h) now also degrades the
[health endpoint](#health-endpoint) (`reason: "offsite-stale"`), so a mirror that quietly
stopped is visible to uptime monitors.

**What the off-volume mirror covers.** The mirror copies the **database snapshot** (+ its
verify sidecar) and **`data/uploads/`** (medical files). It does **not** mirror
`data/integration-payloads/` (raw provider payloads, re-syncable from the source integration)
or `data/logs/ai.jsonl` (the AI audit log) — this is a deliberate scope decision to keep the
mirror to the recoverable clinical dataset; if you want those off-volume too, copy them with
your own out-of-band job.

The uploads mirror is **append-only** for ordinary single-row deletes (a re-synced or
hand-corrected row keeps its durable copy) — with one exception: **deleting a profile**
(Settings → Family) is a deliberate "right to delete" that best-effort unlinks that person's
medical files **and** their off-volume mirror copies (when `BACKUP_DEST_DIR` is mounted and
verified), so a deleted person's documents don't linger on the NAS after their DB traces have
rotated out of every snapshot.

```bash
# docker-compose: mount a second host directory and point the env at it
#   volumes:
#     - "${DATA_DIR:-./data}:/app/data"
#     - "/mnt/nas/allos-backup:/backup"     # second, independent volume
#   environment:
#     BACKUP_DEST_DIR: /backup
```

> **Uploads caveat (no second mount):** without `BACKUP_DEST_DIR`, uploaded medical files
> (`data/uploads/`) and captured integration payloads (`data/integration-payloads/`) live on
> disk, _not_ in the database, so the snapshot does **not** include them. For a complete
> backup then, copy the whole `DATA_DIR` (database + `uploads/` + `integration-payloads/`).

### Scheduling without the notify sidecar

Backups are driven from the hourly notify tick by default. If you removed the notify
sidecar, drive them with the standalone entrypoint instead — it applies the same
schedule/retention/verification and is safe to run hourly by cron:

```cron
0 * * * * cd /app && npm run backup
```

`npm run backup -- now` forces an immediate (verified) snapshot regardless of the schedule.

### Restore

Use the restore tool (`npm run restore`) — it lists snapshots with their integrity status
**and schema version**, verifies the chosen one before trusting it, copies the current live
DB aside as a rollback (`allos.db.pre-restore-<timestamp>`, **including its `-wal`/`-shm`** so a
rollback keeps WAL-only committed transactions), then installs the snapshot via an **atomic
rename** (a kill mid-restore leaves the old DB intact, not a torn file) and clears any stale
`-wal`/`-shm` sidecars. It **refuses a snapshot whose schema is newer than the running build**
(which would only trip the boot-time downgrade guard) unless you pass `--force`. Old aside
copies are pruned to the newest few by the backup tick.

```bash
npm run restore                       # list snapshots + integrity status
npm run restore -- allos-<stamp>.db   # restore that snapshot (prompts to confirm)
npm run restore -- allos-<stamp>.db --yes    # skip the confirmation prompt
npm run restore -- allos-<stamp>.db --force  # also override safety refusals

# Restore from an OFF-VOLUME copy (BACKUP_DEST_DIR mirror):
npm run restore -- --from /backup                     # list snapshots on the mirror
npm run restore -- --from /backup allos-<stamp>.db    # restore one from the mirror
npm run restore -- --from                             # bare --from uses BACKUP_DEST_DIR
```

**Stop the container/app before restoring.** The tool makes a best-effort check for a live
DB connection and refuses if it detects one, but in WAL mode an _idle_ connection may not be
detected, so always stop the app first. `--force` overrides both the running check and a
failed-integrity refusal.

**Putting uploads back.** A snapshot restores only the database. When recovering from an
off-volume mirror (or any full-directory backup), also copy the uploaded medical files back
so `medical_documents` rows aren't left pointing at missing files — `--from` prints the exact
command, e.g. `cp -a /backup/uploads/. data/uploads/`.

You can still restore by hand if you prefer: stop the container, `cp
data/backups/allos-<stamp>.db data/allos.db`, delete any `data/allos.db-wal` /
`data/allos.db-shm`, and start it again.

### Moving to a new server

To migrate a running instance to a new host, **copy the whole `DATA_DIR`** — the
database plus everything alongside it on disk (`uploads/`, `integration-payloads/`,
`backups/`). Everything Allos persists lives under that one directory (outside the
checkout), so a faithful move is a directory copy, not a database-only step:

```bash
# on the OLD host, with the app stopped:
rsync -a "$DATA_DIR"/ newhost:/path/to/allos-data/
# on the NEW host: point DATA_DIR at the copy and start the container
```

Stop the app on the old host first so the SQLite WAL is checkpointed and no file
changes mid-copy. Do **not** use the **Data → Export all my data** ZIP for this — that
is a readable **portability** artifact (JSON/CSV + a FHIR passport) for taking a
profile's record to another tool, **not** a restore image: it omits operational state
(connections, sessions, sync history) and can't rebuild an instance. The `DATA_DIR`
copy (or a [backup snapshot](#backups) plus its `uploads/`) is the restore path.

## Health endpoint

The container healthcheck hits `GET /api/health`. It returns
`{ status, reason?, lastBackupAgeHours }` and flips to HTTP **503**
(`status: "degraded"`) for any of the following, so the Docker healthcheck marks the
container unhealthy:

- **`db-failed`** — the DB is not readable.
- **`write-failed`** — `data/` is not writable (a full or read-only disk answers reads but
  fails writes).
- **`integrity-failed`** — the cached weekly live-DB `integrity_check` (above) last found
  **corruption**. The endpoint only reads this cached verdict; it never runs the expensive
  `integrity_check` itself, so it stays cheap enough for a frequent uptime poll.
- **`backup-stale`** — backups are enabled and the newest snapshot is older than the
  staleness threshold (**48h** by default; override with the `backup_staleness_hours`
  global setting). A brand-new instance inside its grace window is **not** flagged here — see
  `backups-never-ran` below for the perpetually-unbackuped case.
- **`backups-never-ran`** — backups are enabled but **no snapshot has ever been taken** and
  the instance is older than a short grace period (**72h**). This catches a deployment with
  no backup scheduler at all (the notify sidecar dropped and no cron replacing it) —
  previously such an instance stayed permanently green because the never-backed-up exemption
  never expired. A genuinely fresh install is exempt until it crosses the grace window
  (instance age comes from an `install_first_boot_at` marker seeded on first boot).
- **`offsite-stale`** — backups are **enabled**, an off-volume destination (`BACKUP_DEST_DIR`)
  is configured, and its last successful replica is older than the staleness threshold, so a
  mirror that silently stopped is visible to uptime monitors (a never-succeeded mirror surfaces
  instead as an off-volume error on the admin card — see [Off-volume backups](#off-volume-backups-backup_dest_dir)).
  Like the primary `backup-stale`/`backups-never-ran` alarms, this is suppressed when backups
  are **disabled** — replication only runs as a byproduct of the snapshot schedule, so a
  disabled schedule (with `BACKUP_DEST_DIR` still set) doesn't flip the endpoint to a permanent
  `offsite-stale`.

The body stays deliberately coarse (a `status`, a single `reason`, and `lastBackupAgeHours`)
with no paths, versions, or PHI, since the endpoint is unauthenticated — details go to the
server logs. `lastBackupAgeHours` reports hours since the last successful backup (null when
never backed up).

**Notification delivery failures.** A failed Telegram, push, or Home Assistant send is
also persisted as a global marker (`notify_last_error`, naming the channel that failed,
cleared on the next successful send to that channel) and surfaced on
**Settings → Server → Telegram bot**, so a revoked bot token, wrong chat id, or an
unreachable HA webhook is visible
instead of only appearing as a notify-tick exit code. The per-profile **Send test** button
on **Settings → Profile** is the remediation path — a successful test clears the marker.
