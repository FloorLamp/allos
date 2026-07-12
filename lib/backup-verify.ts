// Pure decision logic for backup integrity verification, restore safety, and
// backup-staleness math (issues #25/#26). No DB/fs/network here — the fs +
// PRAGMA side effects live in lib/backup.ts and scripts/restore.ts; this module
// is unit-tested in lib/__tests__/backup-verify.test.ts.

// Per-snapshot verification outcome, persisted as a JSON sidecar next to the
// snapshot (see verificationSidecarName). A sidecar is simpler than a table: it
// needs no schema migration, travels with the snapshot file (a restore script
// can read it without opening the app DB), and is trivially removed alongside
// its snapshot when the retention policy prunes it.
export interface BackupVerification {
  integrity: "ok" | "failed";
  checkedAt: string; // ISO timestamp of the check
  detail?: string; // failure detail (omitted when integrity === "ok")
}

// The sidecar filename for a snapshot. Ends in ".json" (not ".db") so it is
// never mistaken for a snapshot by listBackupNames' ".db" filter.
export function verificationSidecarName(snapshotName: string): string {
  return `${snapshotName}.json`;
}

// Pull the human-readable messages out of a `PRAGMA integrity_check` result.
// better-sqlite3 returns an array of single-column row objects (column name
// `integrity_check`); a healthy DB yields exactly one row whose value is "ok".
function extractIntegrityMessages(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r === "string") {
      out.push(r);
    } else if (r && typeof r === "object") {
      const v = Object.values(r as Record<string, unknown>)[0];
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

// Interpret a `PRAGMA integrity_check` result into ok + an optional detail.
// Anything other than the single "ok" row is a failure; the first several error
// lines are joined into `detail` for logging/persistence.
export function interpretIntegrityRows(rows: unknown): {
  ok: boolean;
  detail?: string;
} {
  const messages = extractIntegrityMessages(rows);
  if (messages.length === 1 && messages[0].trim().toLowerCase() === "ok") {
    return { ok: true };
  }
  const detail =
    messages.slice(0, 10).join("; ") || "unknown integrity failure";
  return { ok: false, detail };
}

// Hours since the last successful backup, or null when never backed up / the
// stored timestamp is unparseable. Clamped at 0 so clock skew can't report a
// negative age. Rounded to 2 decimals (coarse operational data).
export function backupAgeHours(
  lastBackupAt: string | null | undefined,
  now: Date
): number | null {
  if (!lastBackupAt) return null;
  const then = Date.parse(lastBackupAt);
  if (Number.isNaN(then)) return null;
  const hours = (now.getTime() - then) / 3_600_000;
  return Math.round(Math.max(0, hours) * 100) / 100;
}

// Whether the periodic live-DB integrity check is due: run once per ISO week,
// gated by the stored week key of the last run.
export function isLiveIntegrityCheckDue(
  lastWeekKey: string | undefined | null,
  currentWeekKey: string
): boolean {
  return lastWeekKey !== currentWeekKey;
}

// Restore-safety decision. Refuse when the app appears to be running (unless
// forced) so a live connection isn't clobbered underneath it, and refuse when
// the chosen snapshot failed its integrity check (unless forced).
export interface RestoreDecision {
  proceed: boolean;
  reason?: "app-running" | "snapshot-failed-integrity";
}

export function decideRestore(opts: {
  snapshotOk: boolean;
  appRunning: boolean;
  force: boolean;
}): RestoreDecision {
  if (opts.appRunning && !opts.force)
    return { proceed: false, reason: "app-running" };
  if (!opts.snapshotOk && !opts.force)
    return { proceed: false, reason: "snapshot-failed-integrity" };
  return { proceed: true };
}

// Whether a snapshot's schema version is compatible with the running build (#472).
// A snapshot whose `PRAGMA user_version` EXCEEDS this build's migration count was
// written by a NEWER release — installing it makes the boot-time downgrade guard
// refuse to start (and its error points the operator right back at restore, a
// loop). Refuse up front unless forced. When either input is unknown (null/
// undefined) the gate is a no-op — we only refuse on a definite newer-schema.
export function decideSnapshotVersion(opts: {
  snapshotUserVersion?: number | null;
  buildMigrationCount?: number | null;
  force: boolean;
}): { ok: boolean; snapshotNewer: boolean } {
  const { snapshotUserVersion, buildMigrationCount, force } = opts;
  const snapshotNewer =
    snapshotUserVersion != null &&
    buildMigrationCount != null &&
    snapshotUserVersion > buildMigrationCount;
  return { ok: force || !snapshotNewer, snapshotNewer };
}
