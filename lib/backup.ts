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
import {
  MirrorEntry,
  OFFSITE_SENTINEL,
  checkOffsiteReadiness,
  planUploadMirror,
  resolveOffsiteDir,
} from "./backup-offsite";
import { createLogger } from "./log";

const log = createLogger("backup");

// The backup directory, under data/ so it lands on the DATA_DIR bind mount.
export function backupsDir(): string {
  return path.join(process.cwd(), "data", "backups");
}

// The uploaded-medical-files root (data/uploads). These files live on disk, not in
// the SQLite snapshot, so the off-volume durability path mirrors them (issue #130).
export function uploadsDir(): string {
  return path.join(process.cwd(), "data", "uploads");
}

// The operator-configured OFF-VOLUME backup destination (BACKUP_DEST_DIR), or null
// when unset — a second directory the operator mounts (NAS / other disk / synced
// folder) so a loss of the DATA_DIR volume doesn't take every backup with it.
export function backupDestDir(): string | null {
  return resolveOffsiteDir(process.env.BACKUP_DEST_DIR);
}

// Whether an off-volume destination is configured (surfaced read-only in the admin
// backup card so an operator can see durability is / isn't in effect).
export function isOffsiteConfigured(): boolean {
  return backupDestDir() !== null;
}

// ISO timestamp of the last successful off-volume replication, or null.
export function getLastOffsiteBackupAt(): string | null {
  return getSetting("backup_offsite_last_at") ?? null;
}

// The last recorded off-volume replication error (cleared on the next success), or
// null. Recorded under its own key so an off-volume failure is visible without
// masking (or being masked by) the primary snapshot's own `backup_last_error`.
export function getLastOffsiteError(): string | null {
  return getSetting("backup_offsite_last_error") || null;
}

// Whether the configured off-volume destination is presently MOUNTED and verified
// (root exists as a directory + carries the sentinel), or must be skipped (#463).
// Reads the fs; returns { ready:false } with no reason when nothing is configured.
export function getOffsiteReadiness():
  | { configured: false }
  | { configured: true; ready: boolean; reason?: string } {
  const dest = backupDestDir();
  if (!dest) return { configured: false };
  const rootExists = fs.existsSync(dest);
  const rootIsDir = rootExists && fs.statSync(dest).isDirectory();
  const sentinelPresent =
    rootIsDir && fs.existsSync(path.join(dest, OFFSITE_SENTINEL));
  const r = checkOffsiteReadiness({ rootExists, rootIsDir, sentinelPresent });
  return r.ready
    ? { configured: true, ready: true }
    : { configured: true, ready: false, reason: r.reason };
}

// Initialize the off-volume destination: write the sentinel file into the mounted
// root so replication is allowed (#463). The root must already EXIST as a directory
// (i.e. the second volume is mounted) — we never create the root ourselves, which
// is the whole point. Returns a friendly outcome the admin action surfaces.
export function initOffsiteDestination(): { ok: boolean; message: string } {
  const dest = backupDestDir();
  if (!dest) {
    return { ok: false, message: "BACKUP_DEST_DIR is not configured." };
  }
  if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
    return {
      ok: false,
      message: `Destination ${dest} does not exist as a directory — mount the second volume first, then verify.`,
    };
  }
  try {
    fs.writeFileSync(
      path.join(dest, OFFSITE_SENTINEL),
      `allos off-volume backup destination — created ${new Date().toISOString()}\n`
    );
  } catch (e) {
    return {
      ok: false,
      message: `Could not write the sentinel into ${dest}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  return {
    ok: true,
    message: `Verified — wrote ${OFFSITE_SENTINEL} into ${dest}. Off-volume backups are now enabled.`,
  };
}

export interface BackupInfo {
  name: string;
  size: number; // bytes
  mtimeMs: number;
}

// All snapshot files currently in `dir` (filenames only), newest first by name.
// Defaults to the primary backup directory; the restore tool passes an off-volume
// directory (`--from`) to list snapshots replicated to a secondary destination.
export function listBackupNames(dir: string = backupsDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("allos-") && n.endsWith(".db"))
    .sort()
    .reverse();
}

// The most recent snapshot's metadata, or null when none exist.
export function getLastBackup(dir: string = backupsDir()): BackupInfo | null {
  const names = listBackupNames(dir);
  if (names.length === 0) return null;
  const name = names[0];
  const st = fs.statSync(path.join(dir, name));
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
  snapshotName: string,
  dir: string = backupsDir()
): BackupVerification | null {
  const p = path.join(dir, verificationSidecarName(snapshotName));
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
export function verifySnapshot(
  snapshotName: string,
  dir: string = backupsDir()
): BackupVerification {
  const full = path.join(dir, snapshotName);
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
      path.join(dir, verificationSidecarName(snapshotName)),
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

// Walk a directory tree and return every file as a { rel, size } entry (rel is the
// path relative to `root`). Missing root → empty list. Used to diff the uploads
// tree against its off-volume mirror; source and destination are both walked here
// so their `rel` strings compare directly.
export function listUploadFiles(root: string): MirrorEntry[] {
  if (!fs.existsSync(root)) return [];
  const out: MirrorEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? path.join(prefix, ent.name) : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        try {
          out.push({ rel, size: fs.statSync(abs).size });
        } catch {
          // A file that vanished between readdir and stat (concurrent prune) is
          // simply skipped — it'll be picked up on the next backup if it returns.
        }
      }
    }
  };
  walk(root, "");
  return out;
}

export interface OffsiteResult {
  replicated: boolean; // false when no destination is configured OR it was skipped
  // Set when a destination IS configured but replication was skipped because it
  // isn't mounted/verified (#463) — the caller records `reason` as an off-volume
  // error instead of a false success. Absent when nothing is configured.
  skipped?: boolean;
  skipReason?: string;
  dest?: string;
  snapshotCopied?: boolean;
  uploadsCopied?: number; // files copied by the incremental uploads mirror
  pruned?: number;
}

// Replicate a verified snapshot OFF-VOLUME (issue #130). When BACKUP_DEST_DIR is
// configured (a second mounted directory), copy the just-written snapshot + its
// verification sidecar into the destination root (same filenames, so
// `restore --from <dest>` lists and restores them directly), prune the destination
// to the same retention policy, and mirror the medical uploads tree so a restore
// from the secondary volume also recovers the on-disk files. Immutable,
// content-hashed uploads make the mirror cheap (only new/size-changed files copy),
// keeping this safe to run on every (daily) snapshot.
//
// This performs fs side effects but touches NO settings — the caller records the
// `backup_offsite_last_*` markers from the returned result / a thrown error — so it
// stays unit-testable against temp dirs (lib/__db_tests__/backup-offsite.test.ts).
// `opts` lets tests inject the destination / source roots and retention; production
// callers pass none and get the real dirs + configured retention.
export function replicateToOffsite(
  snapshotName: string,
  opts: {
    destDir?: string | null;
    sourceBackupsDir?: string;
    uploadsRoot?: string;
    keepDaily?: number;
    keepWeekly?: number;
  } = {}
): OffsiteResult {
  const dest = opts.destDir !== undefined ? opts.destDir : backupDestDir();
  if (!dest) return { replicated: false };

  // Never mkdir the destination ROOT (#463). It must pre-exist as a directory AND
  // carry the sentinel — otherwise the "destination" is a bare (unmounted) mount
  // point or a fresh path in the container's ephemeral layer, and copying into it
  // reports a durable backup that evaporates on the next redeploy. Skip + surface a
  // reason instead. (Subdirectories UNDER a verified root — uploads/ — are still
  // created freely below.)
  const rootExists = fs.existsSync(dest);
  const rootIsDir = rootExists && fs.statSync(dest).isDirectory();
  const sentinelPresent =
    rootIsDir && fs.existsSync(path.join(dest, OFFSITE_SENTINEL));
  const readiness = checkOffsiteReadiness({
    rootExists,
    rootIsDir,
    sentinelPresent,
  });
  if (!readiness.ready) {
    return { replicated: false, skipped: true, skipReason: readiness.reason };
  }

  const srcDir = opts.sourceBackupsDir ?? backupsDir();

  // 1. Copy the verified snapshot + its verification sidecar into the dest root.
  const snapSrc = path.join(srcDir, snapshotName);
  fs.copyFileSync(snapSrc, path.join(dest, snapshotName));
  const sidecar = verificationSidecarName(snapshotName);
  const sidecarSrc = path.join(srcDir, sidecar);
  if (fs.existsSync(sidecarSrc)) {
    fs.copyFileSync(sidecarSrc, path.join(dest, sidecar));
  }

  // 2. Prune the destination to the same retention as the primary volume, so the
  //    off-volume copy doesn't grow unbounded. Never prune the snapshot we just
  //    copied.
  let keepDaily = opts.keepDaily;
  let keepWeekly = opts.keepWeekly;
  if (keepDaily === undefined || keepWeekly === undefined) {
    const cfg = getBackupSettings();
    keepDaily = keepDaily ?? cfg.keepDaily;
    keepWeekly = keepWeekly ?? cfg.keepWeekly;
  }
  const { prune } = planBackupRotation(listBackupNames(dest), {
    keepDaily,
    keepWeekly,
  });
  let pruned = 0;
  for (const p of prune) {
    if (p === snapshotName) continue;
    try {
      fs.unlinkSync(path.join(dest, p));
      const sc = path.join(dest, verificationSidecarName(p));
      if (fs.existsSync(sc)) fs.unlinkSync(sc);
      pruned++;
    } catch (e) {
      log.warn("off-volume prune failed", {
        file: p,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 3. Mirror the uploads tree (medical files are PHI and live only on disk).
  //    Append-only, incremental: copy only files missing (or size-changed) at the
  //    destination — content-hashed immutable files mean same-name ⇒ same content.
  const uploadsRoot = opts.uploadsRoot ?? uploadsDir();
  const destUploads = path.join(dest, "uploads");
  const toCopy = planUploadMirror(
    listUploadFiles(uploadsRoot),
    listUploadFiles(destUploads)
  );
  for (const rel of toCopy) {
    const from = path.join(uploadsRoot, rel);
    const to = path.join(destUploads, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  return {
    replicated: true,
    dest,
    snapshotCopied: true,
    uploadsCopied: toCopy.length,
    pruned,
  };
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

  // Off-volume replication (issue #130): with BACKUP_DEST_DIR configured, copy the
  // verified snapshot + mirror uploads to a second mount. A failure here NEVER
  // fails the primary backup (which already succeeded on the main volume) — it's
  // recorded under `backup_offsite_last_error` so staleness stays visible, then
  // swallowed.
  try {
    const offsite = replicateToOffsite(name);
    if (offsite.replicated) {
      setSetting("backup_offsite_last_at", new Date().toISOString());
      setSetting("backup_offsite_last_error", "");
      log.info("off-volume backup complete", {
        dest: offsite.dest,
        uploadsCopied: offsite.uploadsCopied,
        pruned: offsite.pruned,
      });
    } else if (offsite.skipped && offsite.skipReason) {
      // Configured but not mounted/verified (#463): record the reason as an
      // off-volume error (visible on the admin card + folded into health) instead
      // of the old silent mkdir-into-ephemeral-fs "success". Do NOT touch
      // backup_offsite_last_at — a broken mount must not look freshly backed up.
      setSetting("backup_offsite_last_error", offsite.skipReason);
      log.warn("off-volume backup skipped — destination not ready", {
        reason: offsite.skipReason,
      });
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    setSetting("backup_offsite_last_error", err);
    log.error("off-volume backup failed", {
      err: e instanceof Error ? e : err,
    });
  }

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
