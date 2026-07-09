// Health/readiness endpoint for the Docker healthcheck (issues #26). Probes both
// that the DB is readable AND that the data dir is WRITABLE — a full or read-only
// disk still answers reads, so a read-only `SELECT 1` would report healthy while
// every write 500s. A failed probe returns HTTP 503 so the container healthcheck
// (which keys off response.ok) actually flips to unhealthy.
//
// The body stays deliberately coarse — `status`, a coarse `reason`, and a coarse
// `lastBackupAgeHours` — with no paths, versions, or PHI, since this endpoint is
// unauthenticated.
import fs from "node:fs";
import path from "node:path";
import { buildHealthStatus } from "@/lib/health-status";

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
  try {
    const { db } = await import("@/lib/db");
    db.prepare("SELECT 1").get();
    const { getSetting } = await import("@/lib/settings");
    lastBackupAt = getSetting("backup_last_at") ?? null;
  } catch (err) {
    // Log the real reason server-side, but keep the body generic.
    console.error("health check: DB read failed", err);
    readOk = false;
  }

  const writeOk = readOk ? probeWrite() : false;

  const result = buildHealthStatus({
    readOk,
    writeOk,
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
