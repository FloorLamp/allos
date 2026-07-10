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
// The body stays deliberately coarse — `status`, a coarse `reason`, and a coarse
// `lastBackupAgeHours` — with no paths, versions, or PHI, since this endpoint is
// unauthenticated.
import fs from "node:fs";
import path from "node:path";
import {
  buildHealthStatus,
  DEFAULT_BACKUP_STALENESS_HOURS,
} from "@/lib/health-status";

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

export async function GET() {
  let readOk = true;
  let lastBackupAt: string | null = null;
  let liveIntegrityOk: boolean | null = null;
  let backupsEnabled = false;
  let stalenessThresholdHours = DEFAULT_BACKUP_STALENESS_HOURS;
  try {
    const { db } = await import("@/lib/db");
    db.prepare("SELECT 1").get();
    const { getSetting, getBackupSettings } = await import("@/lib/settings");
    lastBackupAt = getSetting("backup_last_at") ?? null;
    // Cached weekly integrity verdict: "0" = corruption found, "1" = ok,
    // undefined = never run yet (treated as not-a-failure). No PRAGMA here.
    const integrityRaw = getSetting("backup_live_integrity_ok");
    liveIntegrityOk = integrityRaw === undefined ? null : integrityRaw === "1";
    backupsEnabled = getBackupSettings().enabled;
    const thresholdRaw = Number(getSetting("backup_staleness_hours"));
    if (Number.isFinite(thresholdRaw) && thresholdRaw > 0)
      stalenessThresholdHours = thresholdRaw;
  } catch (err) {
    // Log the real reason server-side, but keep the body generic.
    console.error("health check: DB read failed", err);
    readOk = false;
  }

  const writeOk = readOk ? probeWrite() : false;

  const result = buildHealthStatus({
    readOk,
    writeOk,
    liveIntegrityOk,
    backupsEnabled,
    stalenessThresholdHours,
    lastBackupAt,
    now: new Date(),
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
