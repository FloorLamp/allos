// Pure logic for the /api/health readiness endpoint (issue #26). Turns the
// outcome of a read probe + a write probe (+ the last-backup marker) into the
// coarse response body and HTTP status the Docker healthcheck consumes. No
// DB/fs here — the probes run in the route; this is unit-tested in
// lib/__tests__/health-status.test.ts.

import { backupAgeHours } from "./backup-verify";

export type HealthState = "ok" | "degraded";

export interface HealthResult {
  ok: boolean;
  status: HealthState;
  reason?: "db-failed" | "write-failed";
  lastBackupAgeHours: number | null;
  httpStatus: number;
}

// Build the health response. A failed read probe (DB unreachable) or write probe
// (read-only / full disk) is `degraded` + HTTP 503 so the container healthcheck
// (which keys off response.ok) actually flips. The read failure takes precedence
// in the reason. The body stays coarse: a status, a coarse reason, and a coarse
// backup age — no paths, versions, or PHI.
export function buildHealthStatus(opts: {
  readOk: boolean;
  writeOk: boolean;
  lastBackupAt?: string | null;
  now: Date;
}): HealthResult {
  const lastBackupAgeHours = backupAgeHours(opts.lastBackupAt, opts.now);
  if (!opts.readOk) {
    return {
      ok: false,
      status: "degraded",
      reason: "db-failed",
      lastBackupAgeHours,
      httpStatus: 503,
    };
  }
  if (!opts.writeOk) {
    return {
      ok: false,
      status: "degraded",
      reason: "write-failed",
      lastBackupAgeHours,
      httpStatus: 503,
    };
  }
  return { ok: true, status: "ok", lastBackupAgeHours, httpStatus: 200 };
}
