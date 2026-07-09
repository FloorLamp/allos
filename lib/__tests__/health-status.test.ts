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
});
