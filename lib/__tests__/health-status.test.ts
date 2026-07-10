import { describe, it, expect } from "vitest";
import { buildHealthStatus } from "../health-status";

const now = new Date("2026-07-09T12:00:00Z");

describe("buildHealthStatus", () => {
  it("is ok + 200 when both probes pass", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      lastBackupAt: "2026-07-09T06:00:00Z",
      now,
    });
    expect(r).toEqual({
      ok: true,
      status: "ok",
      lastBackupAgeHours: 6,
      httpStatus: 200,
    });
  });

  it("is degraded + 503 with write-failed when the write probe fails", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: false,
      lastBackupAt: null,
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("degraded");
    expect(r.reason).toBe("write-failed");
    expect(r.httpStatus).toBe(503);
    expect(r.lastBackupAgeHours).toBeNull();
  });

  it("is degraded + 503 with db-failed when the read probe fails", () => {
    const r = buildHealthStatus({
      readOk: false,
      writeOk: false,
      lastBackupAt: "2026-07-09T06:00:00Z",
      now,
    });
    expect(r.reason).toBe("db-failed");
    expect(r.httpStatus).toBe(503);
  });

  it("prefers db-failed over write-failed when both are down", () => {
    const r = buildHealthStatus({
      readOk: false,
      writeOk: false,
      lastBackupAt: null,
      now,
    });
    expect(r.reason).toBe("db-failed");
  });

  it("reports a null backup age when never backed up", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      lastBackupAt: null,
      now,
    });
    expect(r.lastBackupAgeHours).toBeNull();
  });

  // --- Live-integrity marker (#131) ---

  it("is degraded + 503 with integrity-failed when the cached integrity check failed", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      liveIntegrityOk: false,
      lastBackupAt: "2026-07-09T06:00:00Z",
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("degraded");
    expect(r.reason).toBe("integrity-failed");
    expect(r.httpStatus).toBe(503);
  });

  it("stays ok when integrity is passing or never-run", () => {
    for (const liveIntegrityOk of [true, null, undefined] as const) {
      const r = buildHealthStatus({
        readOk: true,
        writeOk: true,
        liveIntegrityOk,
        lastBackupAt: "2026-07-09T06:00:00Z",
        now,
      });
      expect(r.ok).toBe(true);
      expect(r.httpStatus).toBe(200);
    }
  });

  it("prefers db-failed / write-failed over integrity-failed", () => {
    expect(
      buildHealthStatus({
        readOk: false,
        writeOk: false,
        liveIntegrityOk: false,
        now,
      }).reason
    ).toBe("db-failed");
    expect(
      buildHealthStatus({
        readOk: true,
        writeOk: false,
        liveIntegrityOk: false,
        now,
      }).reason
    ).toBe("write-failed");
  });

  // --- Backup staleness (#131) ---

  it("is degraded + 503 with backup-stale past the threshold when backups enabled", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-06T12:00:00Z", // 72h before `now`
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("backup-stale");
    expect(r.httpStatus).toBe(503);
    expect(r.lastBackupAgeHours).toBe(72);
  });

  it("stays ok within the staleness threshold", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-08T12:00:00Z", // 24h before `now`
      now,
    });
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
  });

  it("uses the 48h default threshold when none is passed", () => {
    // 60h old, no explicit threshold → past the 48h default → stale.
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      lastBackupAt: "2026-07-07T00:00:00Z",
      now,
    });
    expect(r.reason).toBe("backup-stale");
  });

  it("never flags staleness when backups are disabled", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: false,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-06-01T12:00:00Z", // ancient
      now,
    });
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
  });

  it("never flags staleness when no backup has ever been taken", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: null,
      now,
    });
    expect(r.ok).toBe(true);
    expect(r.lastBackupAgeHours).toBeNull();
  });

  it("prefers integrity-failed over backup-stale", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      liveIntegrityOk: false,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-06-01T12:00:00Z",
      now,
    });
    expect(r.reason).toBe("integrity-failed");
  });
});
