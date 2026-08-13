// Health/readiness endpoint for the Docker healthcheck (issues #26/#131). Probes
// both that the DB is readable AND that the data dir is WRITABLE — a full or
// read-only disk still answers reads, so a read-only `SELECT 1` would report
// healthy while every write 500s. It ALSO folds in two cached failure markers the
// pipeline already computes but that previously reached no one (#131): the weekly
// live-DB `PRAGMA integrity_check` result (`backup_live_integrity_ok`) and backup
// staleness (age of the newest snapshot vs a configurable threshold). A failed
// probe/marker returns HTTP 503 so the container healthcheck (which keys off
// response.ok) actually flips to unhealthy.
//
// CHEAP BY DESIGN: this endpoint is polled by uptime monitors (a 30s healthcheck
// interval), so it NEVER runs integrity_check itself — that expensive PRAGMA runs
// at most once per ISO week from the notify tick (runLiveIntegrityCheck) and
// stores its verdict; here we only read that cached marker plus two more O(1)
// settings lookups on top of the existing read/write probes.
//
// It also reads the data volume's FREE SPACE (#1856) — one statfs plus one stat of
// the DB file — so a filling disk is reported before it turns into `write-failed`.
// See lib/health-status.ts for why that alarm exists and where it sits.
//
// The body stays deliberately coarse — `status`, a coarse `reason`, and a coarse
// `lastBackupAgeHours` — with no paths, versions, or PHI, since this endpoint is
// unauthenticated. Everything the new probes read (byte counts, the DB size, the
// configured floor) stays server-side; only the reason WORD reaches the client.
import fs from "node:fs";
import path from "node:path";
import {
  buildHealthStatus,
  clampDiskFloorPercent,
  DEFAULT_BACKUP_STALENESS_HOURS,
} from "@/lib/health-status";
import { backupAgeHours } from "@/lib/backup-verify";

export const dynamic = "force-dynamic";

// Cheap writability probe: write a few bytes to a dotfile under data/ and
// delete it. Chosen over `wal_checkpoint` because it directly exercises the data
// dir (the actual failure mode — a full/read-only bind mount) and reliably
// catches ENOSPC/EROFS regardless of SQLite's WAL state. It's tiny and runs on a
// 30s healthcheck interval.
function probeWrite(): boolean {
  // Unique per call so two concurrent probes can't unlink each other's file.
  const p = path.join(
    process.cwd(),
    "data",
    `.healthcheck-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  try {
    fs.writeFileSync(p, String(Date.now()));
    fs.unlinkSync(p);
    return true;
  } catch (err) {
    console.error("health check: data dir not writable", err);
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort cleanup */
    }
    return false;
  }
}

// Free-space probe (#1856): ONE statfs on the data dir. `write-failed` above only
// notices a full volume after writes already fail — this is the same volume one
// step earlier, and it is what tells an operator the nightly snapshot is about to
// stop landing. Cheap enough for the same 30s poll (a single syscall, no walk).
//
// Everything it returns stays server-side: the free/total bytes feed the pure
// decision and the response body gets only the word `disk-low`, so an
// unauthenticated caller learns nothing about paths, volume size, or how much
// data this instance holds.
function probeDiskSpace(): { freeBytes: number; totalBytes: number } | null {
  try {
    const st = fs.statfsSync(path.join(process.cwd(), "data"));
    return {
      freeBytes: st.bavail * st.bsize,
      totalBytes: st.blocks * st.bsize,
    };
  } catch (err) {
    // statfs is unavailable on some filesystems/platforms. An unrunnable probe is
    // not a failure — log it and leave the disk clause unevaluated.
    console.error("health check: statfs unavailable", err);
    return null;
  }
}

export async function GET() {
  let readOk = true;
  let lastBackupAt: string | null = null;
  let liveIntegrityOk: boolean | null = null;
  let backupsEnabled = false;
  let stalenessThresholdHours = DEFAULT_BACKUP_STALENESS_HOURS;
  let offsiteConfigured = false;
  let lastOffsiteAt: string | null = null;
  let instanceAgeHours: number | null = null;
  let dbSizeBytes: number | null = null;
  const now = new Date();
  try {
    const { db, dbFilePath } = await import("@/lib/db");
    db.prepare("SELECT 1").get();
    // Live DB size (#1856): one stat, for the snapshot-headroom clause below —
    // VACUUM INTO writes a full copy, so "free space" only means something
    // relative to how big the database currently is.
    try {
      dbSizeBytes = fs.statSync(dbFilePath()).size;
    } catch {
      dbSizeBytes = null; // in-memory DB, or a path we cannot stat — clause skipped
    }
    const { getSetting, getBackupSettings } = await import("@/lib/settings");
    lastBackupAt = getSetting("backup_last_at") ?? null;
    // Instance age (#464): seeded once at first boot; lets the never-backed-up
    // exemption expire so a scheduler-less deployment is eventually flagged.
    instanceAgeHours = backupAgeHours(
      getSetting("install_first_boot_at") ?? null,
      now
    );
    // Cached weekly integrity verdict: "0" = corruption found, "1" = ok,
    // undefined = never run yet (treated as not-a-failure). No PRAGMA here.
    const integrityRaw = getSetting("backup_live_integrity_ok");
    liveIntegrityOk = integrityRaw === undefined ? null : integrityRaw === "1";
    // Threshold parsing/clamping lives in getBackupSettings (one computation for
    // the endpoint and the Settings → Server Backups card that edits it, #1869).
    const backup = getBackupSettings();
    backupsEnabled = backup.enabled;
    stalenessThresholdHours = backup.stalenessHours;
    // Off-volume replication staleness (#463): cheap settings-only reads, folded
    // into the same staleness threshold family as the primary backup.
    const { isOffsiteConfigured, getLastOffsiteBackupAt } =
      await import("@/lib/backup");
    offsiteConfigured = isOffsiteConfigured();
    lastOffsiteAt = getLastOffsiteBackupAt();
  } catch (err) {
    // Log the real reason server-side, but keep the body generic.
    console.error("health check: DB read failed", err);
    readOk = false;
  }

  const writeOk = readOk ? probeWrite() : false;
  const disk = readOk ? probeDiskSpace() : null;

  const result = buildHealthStatus({
    readOk,
    writeOk,
    diskFreeBytes: disk?.freeBytes ?? null,
    diskTotalBytes: disk?.totalBytes ?? null,
    dbSizeBytes,
    diskFloorPercent: clampDiskFloorPercent(
      process.env.ALLOS_DISK_FREE_FLOOR_PERCENT
    ),
    liveIntegrityOk,
    backupsEnabled,
    stalenessThresholdHours,
    lastBackupAt,
    instanceAgeHours,
    offsiteConfigured,
    lastOffsiteAt,
    now,
  });

  return Response.json(
    {
      ok: result.ok,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      lastBackupAgeHours: result.lastBackupAgeHours,
    },
    { status: result.httpStatus }
  );
}
