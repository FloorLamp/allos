// Automated SQLite backups (issue #131). Takes a compact single-file snapshot of
// the live DB via `VACUUM INTO` (safe against the open better-sqlite3 connection),
// rotates old snapshots under a keep-N-dailies + M-weeklies policy, and is driven
// from the hourly notify tick. Pure decision logic (when due, what to prune) lives
// in lib/backup-rotation.ts; this module owns the fs + VACUUM side effects.
//
// Snapshots contain multi-profile PHI. They live under data/backups (i.e. inside
// DATA_DIR, on the Docker bind mount) and are NEVER exposed by any route.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { db } from "./db";
import {
  getBackupSettings,
  getInstanceTimezone,
  getSetting,
  setSetting,
} from "./settings";
import { dateStrInTz, hourInTz, zonedDateParts } from "./date";
import {
  backupFilename,
  isBackupDue,
  isoWeekKey,
  planBackupRotation,
} from "./backup-rotation";
import {
  BackupVerification,
  interpretIntegrityRows,
  isLiveIntegrityCheckDue,
  verificationSidecarName,
} from "./backup-verify";
import { createLogger } from "./log";

const log = createLogger("backup");

// The backup directory, under data/ so it lands on the DATA_DIR bind mount.
export function backupsDir(): string {
  return path.join(process.cwd(), "data", "backups");
}

export interface BackupInfo {
  name: string;
  size: number; // bytes
  mtimeMs: number;
}

// All snapshot files currently on disk (filenames only), newest first by name.
export function listBackupNames(): string[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("allos-") && n.endsWith(".db"))
    .sort()
    .reverse();
}

// The most recent snapshot's metadata, or null when none exist.
export function getLastBackup(): BackupInfo | null {
  const names = listBackupNames();
  if (names.length === 0) return null;
  const name = names[0];
  const st = fs.statSync(path.join(backupsDir(), name));
  return { name, size: st.size, mtimeMs: st.mtimeMs };
}

// The last recorded backup error, surfaced in the UI so a failing schedule isn't
// silent. Cleared on the next successful snapshot.
export function getLastBackupError(): string | null {
  return getSetting("backup_last_error") ?? null;
}

// Read a snapshot's verification sidecar (written by verifySnapshot), or null
// when absent/unparseable. Used by the restore tooling to show each snapshot's
// last-known integrity status without re-opening it.
export function readVerification(
  snapshotName: string
): BackupVerification | null {
  const p = path.join(backupsDir(), verificationSidecarName(snapshotName));
  try {
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (
      parsed &&
      (parsed.integrity === "ok" || parsed.integrity === "failed")
    ) {
      return parsed as BackupVerification;
    }
    return null;
  } catch {
    return null;
  }
}

// Open a snapshot read-only and run PRAGMA integrity_check, persisting the
// outcome to a JSON sidecar next to it. Never throws — a check that can't run
// (e.g. the file can't be opened) counts as a failure so a corrupt snapshot is
// never mistaken for a good one. The read-only open guarantees we can't mutate
// the snapshot we're verifying.
export function verifySnapshot(snapshotName: string): BackupVerification {
  const full = path.join(backupsDir(), snapshotName);
  let result: { ok: boolean; detail?: string };
  try {
    const snap = new Database(full, { readonly: true, fileMustExist: true });
    try {
      result = interpretIntegrityRows(snap.pragma("integrity_check"));
    } finally {
      snap.close();
    }
  } catch (e) {
    result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const verification: BackupVerification = {
    integrity: result.ok ? "ok" : "failed",
    checkedAt: new Date().toISOString(),
    ...(result.ok ? {} : { detail: result.detail }),
  };
  try {
    fs.writeFileSync(
      path.join(backupsDir(), verificationSidecarName(snapshotName)),
      JSON.stringify(verification, null, 2)
    );
  } catch (e) {
    // A sidecar-write failure (e.g. full disk) must not mask the check result;
    // log it and carry on with the in-memory verification.
    log.warn("could not write verification sidecar", {
      file: snapshotName,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return verification;
}

// Periodic integrity check of the LIVE database, gated to run once per ISO week
// via a stored marker. Called from every scheduled tick (independent of whether
// a snapshot is due) so slow-growing corruption is noticed even between backups.
// Best-effort: logs the outcome, never throws.
export function runLiveIntegrityCheck(now: Date = new Date()): {
  ran: boolean;
  ok?: boolean;
} {
  const tz = getInstanceTimezone();
  const weekKey = isoWeekKey(dateStrInTz(tz, now));
  if (
    !isLiveIntegrityCheckDue(getSetting("backup_live_integrity_week"), weekKey)
  ) {
    return { ran: false };
  }
  try {
    const result = interpretIntegrityRows(db.pragma("integrity_check"));
    setSetting("backup_live_integrity_week", weekKey);
    setSetting("backup_live_integrity_at", now.toISOString());
    setSetting("backup_live_integrity_ok", result.ok ? "1" : "0");
    if (result.ok) {
      log.info("live integrity check ok");
    } else {
      setSetting("backup_live_integrity_detail", result.detail ?? "");
      log.error("LIVE DATABASE INTEGRITY CHECK FAILED", {
        detail: result.detail,
      });
    }
    return { ran: true, ok: result.ok };
  } catch (e) {
    // A thrown check (rare) shouldn't advance the week marker, so it retries next
    // tick; surface it loudly.
    log.error("live integrity check errored", {
      err: e instanceof Error ? e : String(e),
    });
    return { ran: true, ok: false };
  }
}

// Take one snapshot now, verify its integrity, and prune per the retention
// policy. Throws on snapshot failure (so callers surface it). Returns the
// snapshot's name + size + verification. A snapshot that fails PRAGMA
// integrity_check is NOT counted as a successful backup and pruning is skipped,
// so the previous good snapshots are never rotated away for a corrupt one.
export function performBackup(): {
  name: string;
  size: number;
  verification: BackupVerification;
} {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });

  const tz = getInstanceTimezone();
  const { date, hhmm } = zonedDateParts(tz, new Date());
  const name = backupFilename(date, hhmm);
  const full = path.join(dir, name);

  // VACUUM INTO fails hard if the target already exists, so clear any file at this
  // exact name first: either a partial left by a crashed prior run, or a snapshot
  // from a same-minute manual "Back up now". `full` is always inside backupsDir
  // with our own timestamped name, so this can only remove one of our snapshots.
  if (fs.existsSync(full)) fs.unlinkSync(full);

  // VACUUM INTO wants a string-literal path; single-quotes are doubled to escape.
  // The path is app-controlled (fixed dir + timestamped name), so there's no user
  // input here regardless. A failure here (e.g. ENOSPC) throws to the caller,
  // which records it as a backup error.
  db.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`);

  const size = fs.statSync(full).size;

  // Verify the fresh snapshot before trusting it. A failed check keeps the bad
  // file (with its "failed" sidecar) for forensics but does NOT prune older good
  // snapshots and does NOT record a successful backup.
  const verification = verifySnapshot(name);
  if (verification.integrity !== "ok") {
    const detail = verification.detail ?? "integrity check failed";
    setSetting(
      "backup_last_error",
      `snapshot integrity check failed: ${detail}`
    );
    log.error("SNAPSHOT INTEGRITY CHECK FAILED — keeping previous snapshots", {
      name,
      detail,
    });
    return { name, size, verification };
  }

  // Prune only AFTER a successful, verified snapshot, never before.
  const { keepDaily, keepWeekly } = getBackupSettings();
  const { prune } = planBackupRotation(listBackupNames(), {
    keepDaily,
    keepWeekly,
  });
  for (const p of prune) {
    // Guard against pruning the snapshot we just wrote (it should always be kept,
    // but never delete the freshest copy).
    if (p === name) continue;
    try {
      fs.unlinkSync(path.join(dir, p));
      // Remove the snapshot's verification sidecar too, so it doesn't orphan.
      const sidecar = path.join(dir, verificationSidecarName(p));
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    } catch (e) {
      log.warn("prune failed", {
        file: p,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Record success: dedup date for the scheduler, staleness marker for the health
  // endpoint (backup_last_at), + clear any prior error.
  setSetting("backup_last_date", date);
  setSetting("backup_last_at", new Date().toISOString());
  setSetting("backup_last_size", String(size));
  setSetting("backup_last_error", "");
  log.info("backup complete", {
    name,
    size,
    pruned: prune.length,
    integrity: "ok",
  });
  return { name, size, verification };
}

// Scheduler entrypoint, called once per hourly tick. Runs a snapshot when the
// configured hour is due and none has been taken today; failures are recorded and
// reported (never swallowed) but don't throw, so the notify tick continues.
export function runScheduledBackup(): {
  ran: boolean;
  failed: boolean;
  error?: string;
} {
  // Periodic live-DB integrity check runs every tick (independent of the snapshot
  // schedule), self-gated to once per ISO week. Best-effort — never blocks the
  // snapshot below.
  runLiveIntegrityCheck();

  const cfg = getBackupSettings();
  const tz = getInstanceTimezone();
  const now = new Date();
  const hour = hourInTz(tz, now);
  const today = dateStrInTz(tz, now);
  if (!isBackupDue(cfg, hour, getSetting("backup_last_date"), today)) {
    return { ran: false, failed: false };
  }
  try {
    const { verification } = performBackup();
    if (verification.integrity !== "ok") {
      // The snapshot wrote but failed integrity_check: performBackup already
      // recorded the error and skipped pruning. Surface it as a failed tick, and
      // leave backup_last_date unset (performBackup didn't set it) so the retry
      // window can attempt a fresh snapshot.
      return {
        ran: true,
        failed: true,
        error: verification.detail ?? "snapshot integrity check failed",
      };
    }
    return { ran: true, failed: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Surface the failure but leave backup_last_date unset, mirroring the
    // notify_last_* pattern: a failed attempt stays unmarked so the natural
    // hour+1 retry (slotDue's [hour, hour+1] window) can still recover a transient
    // error. slotDue caps this at two attempts per day, so there's no tight loop.
    setSetting("backup_last_error", error);
    log.error("scheduled backup failed", {
      err: e instanceof Error ? e : error,
    });
    return { ran: true, failed: true, error };
  }
}
