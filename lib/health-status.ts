// Pure logic for the /api/health readiness endpoint (issue #26/#131). Turns the
// outcome of a read probe + a write probe, plus the cached live-integrity marker
// and the last-backup staleness marker, into the coarse response body and HTTP
// status the Docker healthcheck consumes. No DB/fs here — the probes/markers are
// read in the route; this is unit-tested in lib/__tests__/health-status.test.ts.

import { backupAgeHours } from "./backup-verify";

export type HealthState = "ok" | "degraded";

export type HealthReason =
  "db-failed" | "write-failed" | "integrity-failed" | "backup-stale";

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

// Build the health response. A failed read probe (DB unreachable), failed write
// probe (read-only / full disk), a cached failed live-integrity check, or a stale
// backup each make the endpoint `degraded` + HTTP 503 so the container healthcheck
// (which keys off response.ok) actually flips. Precedence, most to least severe:
// db read → write → integrity → backup staleness. The body stays coarse: a status,
// a coarse reason, and a coarse backup age — no paths, versions, or PHI.
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

  const threshold =
    opts.stalenessThresholdHours ?? DEFAULT_BACKUP_STALENESS_HOURS;
  if (
    opts.backupsEnabled &&
    lastBackupAgeHours !== null &&
    lastBackupAgeHours > threshold
  ) {
    return degraded("backup-stale");
  }

  return { ok: true, status: "ok", lastBackupAgeHours, httpStatus: 200 };
}
