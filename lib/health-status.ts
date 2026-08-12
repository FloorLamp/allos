// Pure logic for the /api/health readiness endpoint (issue #26/#131). Turns the
// outcome of a read probe + a write probe, plus the cached live-integrity marker
// and the last-backup staleness marker, into the coarse response body and HTTP
// status the Docker healthcheck consumes. No DB/fs here — the probes/markers are
// read in the route; this is unit-tested in lib/__tests__/health-status.test.ts.

import { backupAgeHours } from "./backup-verify";

export type HealthState = "ok" | "degraded";

export type HealthReason =
  | "db-failed"
  | "write-failed"
  | "integrity-failed"
  | "disk-low"
  | "backup-stale"
  | "backups-never-ran"
  | "offsite-stale";

export interface HealthResult {
  ok: boolean;
  status: HealthState;
  reason?: HealthReason;
  lastBackupAgeHours: number | null;
  httpStatus: number;
}

// Default staleness threshold (#131): a backup schedule that silently died is
// unhealthy once the newest snapshot is older than this. 48h gives a daily
// schedule a full missed day plus slack before it flips. Overridable per-instance
// via the `backup_staleness_hours` global setting.
export const DEFAULT_BACKUP_STALENESS_HOURS = 48;

// Grace window (#464) before a backups-enabled instance that has NEVER taken a
// snapshot is flagged `backups-never-ran`. A fresh install legitimately has no
// backup until its first scheduled run; this covers that plus slack. Past it, a
// still-empty backup dir means NO scheduler is running (notify sidecar dropped, no
// cron) — the disaster the old permanent never-backed-up exemption hid.
export const DEFAULT_BACKUPS_NEVER_RAN_GRACE_HOURS = 72;

// ---- Disk headroom (#1856) ----
//
// `write-failed` is an AFTER-THE-FACT alarm: the write probe writes a few bytes,
// so it only fires once the volume is already full enough to refuse them. By then
// the app is broken. `disk-low` is the same volume seen one step earlier, and it
// exists because of a specific failure order: the nightly snapshot is a
// `VACUUM INTO` (lib/backup.ts), which needs roughly a whole DB's worth of free
// space to land — so on a filling volume the BACKUP is the first thing to fail,
// silently, while the app itself still writes fine. Uploaded medical files grow in
// ~100 MB video-clip steps, so a household instance gets there without warning.
//
// Two independent clauses, either of which flips it:
//  1. FREE SHARE — free bytes under a percentage of the volume. The generic
//     "this disk is nearly full" signal, independent of what Allos is doing.
//  2. SNAPSHOT HEADROOM — free bytes under the live DB size times a factor,
//     checked only when backups are ENABLED (VACUUM INTO only runs then, exactly
//     as `offsite-stale` is gated on the same fact). This is the clause a
//     percentage alone would miss: a 50 GB volume with 10% free and a 6 GB
//     database has plenty of headroom by percentage and cannot take a snapshot.
//
// Unlike the backup alarms this one is TRANSIENT and self-clearing — free space
// and it goes green on the next poll — which is what makes 503 the right answer
// rather than a permanent complaint about how the operator set the box up.
export const DEFAULT_DISK_FREE_FLOOR_PERCENT = 5;

// A snapshot writes a full copy of the database; 1.2 is that copy plus slack for
// the WAL and the verify sidecar. Not configurable — it is a property of what
// VACUUM INTO does, not of the deployment.
export const BACKUP_SNAPSHOT_HEADROOM_FACTOR = 1.2;

// Clamp the operator's `ALLOS_DISK_FREE_FLOOR_PERCENT` override (read in the
// route; parsed here so the rule is pure and unit-tested). Garbage falls back to
// the default. 0 is legal and DISABLES the free-share clause — an operator on a
// multi-terabyte volume where 5% is hundreds of gigabytes can turn it off and
// keep the snapshot-headroom clause, which is the one about this app. Capped at
// 50 so a typo cannot pin the endpoint at 503 forever.
export function clampDiskFloorPercent(raw: string | undefined | null): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DISK_FREE_FLOOR_PERCENT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DISK_FREE_FLOOR_PERCENT;
  return Math.min(n, 50);
}

// The `disk-low` decision on its own, so both clauses are directly testable.
// Unknown free space (statfs unsupported or throwing) answers FALSE: a probe we
// could not run is not evidence of a problem, and must never invent a 503.
export function isDiskLow(opts: {
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  dbSizeBytes?: number | null;
  backupsEnabled?: boolean;
  floorPercent?: number;
}): boolean {
  const free = opts.diskFreeBytes;
  if (free == null || !Number.isFinite(free)) return false;

  const floor = opts.floorPercent ?? DEFAULT_DISK_FREE_FLOOR_PERCENT;
  const total = opts.diskTotalBytes;
  if (floor > 0 && total != null && total > 0) {
    if ((free / total) * 100 < floor) return true;
  }

  if (opts.backupsEnabled && opts.dbSizeBytes != null && opts.dbSizeBytes > 0) {
    if (free < opts.dbSizeBytes * BACKUP_SNAPSHOT_HEADROOM_FACTOR) return true;
  }

  return false;
}

// Build the health response. A failed read probe (DB unreachable), failed write
// probe (read-only / full disk), a cached failed live-integrity check, or a stale
// backup each make the endpoint `degraded` + HTTP 503 so the container healthcheck
// (which keys off response.ok) actually flips. Precedence, most to least severe:
// db read → write → integrity → disk headroom → backup staleness. The body stays
// coarse: a status, a coarse reason, and a coarse backup age — no paths, versions,
// or PHI. `disk-low` keeps that contract by construction: it is one word, and the
// free bytes, volume size, database size and configured floor that produced it are
// all left behind in the route.
//
// Why disk-low sits where it does: below `integrity-failed` (corruption is worse
// than a filling disk) and above the backup alarms (a disk that cannot take a
// snapshot is the CAUSE the staleness alarms are about to report as an effect, and
// naming the cause is more useful to the operator).
//
// Integrity: `liveIntegrityOk` is the cached outcome of the weekly PRAGMA
// integrity_check (runLiveIntegrityCheck in the notify tick) — `false` means the
// last check found corruption; `null`/`undefined` means "never run" and is NOT
// treated as a failure. The health endpoint never runs integrity_check itself, so
// it stays cheap enough for a 30s uptime poll.
//
// Staleness: only enforced when backups are enabled AND at least one snapshot has
// been taken (age !== null). A never-backed-up instance (fresh install, or backups
// just enabled) is not flagged, avoiding a false alarm before the first scheduled
// run; a schedule that ran and then died is caught once its age crosses threshold.
export function buildHealthStatus(opts: {
  readOk: boolean;
  writeOk: boolean;
  liveIntegrityOk?: boolean | null;
  backupsEnabled?: boolean;
  stalenessThresholdHours?: number;
  lastBackupAt?: string | null;
  // Instance age + grace (#464): how long since first boot, and the grace window
  // before a backups-enabled instance with NO snapshot ever is flagged. Lets the
  // never-backed-up exemption EXPIRE (a fresh install is exempt; a months-old
  // instance with an empty backup dir — no scheduler — is not).
  instanceAgeHours?: number | null;
  neverRanGraceHours?: number;
  // Off-volume replication (#130/#463): when a secondary destination is configured,
  // its own staleness folds into health so a mirror that has failed every night for
  // months is visible to an uptime monitor (not just the admin card). Same threshold
  // family as the primary backup; same never-run exemption (age null → not flagged,
  // and item-1's recorded error surfaces the never-succeeded case on the card).
  offsiteConfigured?: boolean;
  lastOffsiteAt?: string | null;
  // Disk headroom (#1856): free/total bytes of the data volume (one statfs in the
  // route) and the live DB file size, plus the operator's clamped percentage floor.
  // All optional — absent means the probe could not run, and isDiskLow answers
  // false rather than inventing an alarm.
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  dbSizeBytes?: number | null;
  diskFloorPercent?: number;
  now: Date;
}): HealthResult {
  const lastBackupAgeHours = backupAgeHours(opts.lastBackupAt, opts.now);
  const degraded = (reason: HealthReason): HealthResult => ({
    ok: false,
    status: "degraded",
    reason,
    lastBackupAgeHours,
    httpStatus: 503,
  });

  if (!opts.readOk) return degraded("db-failed");
  if (!opts.writeOk) return degraded("write-failed");
  if (opts.liveIntegrityOk === false) return degraded("integrity-failed");

  if (
    isDiskLow({
      diskFreeBytes: opts.diskFreeBytes,
      diskTotalBytes: opts.diskTotalBytes,
      dbSizeBytes: opts.dbSizeBytes,
      backupsEnabled: opts.backupsEnabled,
      floorPercent: opts.diskFloorPercent,
    })
  ) {
    return degraded("disk-low");
  }

  const threshold =
    opts.stalenessThresholdHours ?? DEFAULT_BACKUP_STALENESS_HOURS;
  if (
    opts.backupsEnabled &&
    lastBackupAgeHours !== null &&
    lastBackupAgeHours > threshold
  ) {
    return degraded("backup-stale");
  }

  // Never-backed-up alarm (#464): backups enabled, NO snapshot ever, and the
  // instance is past the grace window → no scheduler is taking backups. Distinct
  // from backup-stale (which needs a prior snapshot); the grace expiry is what
  // stops the fresh-install exemption from covering a perpetually-unbackuped box.
  const graceHours =
    opts.neverRanGraceHours ?? DEFAULT_BACKUPS_NEVER_RAN_GRACE_HOURS;
  if (
    opts.backupsEnabled &&
    lastBackupAgeHours === null &&
    opts.instanceAgeHours != null &&
    opts.instanceAgeHours > graceHours
  ) {
    return degraded("backups-never-ran");
  }

  // Off-volume staleness is the least severe (a mirror lag is less urgent than the
  // primary snapshot dying), so it's checked last. Gated on `backupsEnabled` like
  // the primary `backup-stale`/`backups-never-ran` alarms (#620): replication only
  // ever runs as a byproduct of a scheduled snapshot (performBackup refreshes
  // `backup_offsite_last_at`), so a disabled schedule stops refreshing the offsite
  // marker too — without this gate an operator who disables backups (e.g. switching
  // to host-level volume snapshots) while BACKUP_DEST_DIR stays set would flip to a
  // permanent `offsite-stale` 503 48h later, exactly the state the primary alarm is
  // deliberately suppressed for.
  const offsiteAgeHours = backupAgeHours(opts.lastOffsiteAt, opts.now);
  if (
    opts.backupsEnabled &&
    opts.offsiteConfigured &&
    offsiteAgeHours !== null &&
    offsiteAgeHours > threshold
  ) {
    return degraded("offsite-stale");
  }

  return { ok: true, status: "ok", lastBackupAgeHours, httpStatus: 200 };
}
