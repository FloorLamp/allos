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
  planBackupRotation,
} from "./backup-rotation";
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

// Take one snapshot now and prune per the retention policy. Throws on failure (so
// callers surface it) — the prune runs only after the snapshot succeeds. Returns
// the created snapshot's name + size.
export function performBackup(): { name: string; size: number } {
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
  // input here regardless.
  db.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`);

  const size = fs.statSync(full).size;

  // Prune only AFTER a successful snapshot, never before.
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
    } catch (e) {
      log.warn("prune failed", {
        file: p,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Record success: dedup date for the scheduler + clear any prior error.
  setSetting("backup_last_date", date);
  setSetting("backup_last_at", new Date().toISOString());
  setSetting("backup_last_size", String(size));
  setSetting("backup_last_error", "");
  log.info("backup complete", { name, size, pruned: prune.length });
  return { name, size };
}

// Scheduler entrypoint, called once per hourly tick. Runs a snapshot when the
// configured hour is due and none has been taken today; failures are recorded and
// reported (never swallowed) but don't throw, so the notify tick continues.
export function runScheduledBackup(): {
  ran: boolean;
  failed: boolean;
  error?: string;
} {
  const cfg = getBackupSettings();
  const tz = getInstanceTimezone();
  const now = new Date();
  const hour = hourInTz(tz, now);
  const today = dateStrInTz(tz, now);
  if (!isBackupDue(cfg, hour, getSetting("backup_last_date"), today)) {
    return { ran: false, failed: false };
  }
  try {
    performBackup();
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
