import { describe, it, expect } from "vitest";
import {
  buildHealthStatus,
  clampDiskFloorPercent,
  DEFAULT_DISK_FREE_FLOOR_PERCENT,
  isDiskLow,
} from "../health-status";

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

  // --- Never-backed-up alarm (#464) ---

  it("flags backups-never-ran when enabled, no snapshot ever, past the grace window", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      lastBackupAt: null,
      instanceAgeHours: 100, // > 72h grace
      neverRanGraceHours: 72,
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("backups-never-ran");
    expect(r.httpStatus).toBe(503);
  });

  it("exempts a fresh install still inside the grace window", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      lastBackupAt: null,
      instanceAgeHours: 10, // < 72h grace
      neverRanGraceHours: 72,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("never flags backups-never-ran when backups are disabled", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: false,
      lastBackupAt: null,
      instanceAgeHours: 1000,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("does not flag never-ran once a snapshot exists (that's backup-stale's job)", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      lastBackupAt: "2026-07-09T06:00:00Z", // a backup exists, fresh
      instanceAgeHours: 1000,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("stays exempt when instance age is unknown (marker missing)", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      lastBackupAt: null,
      instanceAgeHours: null,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("uses the 72h default grace when none is passed", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      lastBackupAt: null,
      instanceAgeHours: 80, // > 72h default
      now,
    });
    expect(r.reason).toBe("backups-never-ran");
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

  // --- Off-volume staleness (#463) ---

  it("is degraded + 503 with offsite-stale when the mirror is past the threshold", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-09T06:00:00Z", // primary fresh (6h)
      offsiteConfigured: true,
      lastOffsiteAt: "2026-07-06T12:00:00Z", // mirror 72h stale
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("offsite-stale");
    expect(r.httpStatus).toBe(503);
  });

  it("stays ok when the off-volume mirror is within the threshold", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-09T06:00:00Z",
      offsiteConfigured: true,
      lastOffsiteAt: "2026-07-08T12:00:00Z", // 24h
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("never flags offsite staleness when no off-volume copy has been taken", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-09T06:00:00Z",
      offsiteConfigured: true,
      lastOffsiteAt: null,
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("never flags offsite staleness when no destination is configured", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-09T06:00:00Z",
      offsiteConfigured: false,
      lastOffsiteAt: "2026-06-01T12:00:00Z", // ancient, but not configured
      now,
    });
    expect(r.ok).toBe(true);
  });

  it("prefers backup-stale over offsite-stale (primary is more urgent)", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-06T12:00:00Z", // primary 72h stale
      offsiteConfigured: true,
      lastOffsiteAt: "2026-07-06T12:00:00Z", // offsite also stale
      now,
    });
    expect(r.reason).toBe("backup-stale");
  });

  // #620: replication only refreshes its marker as a byproduct of a scheduled
  // snapshot, so disabling backups (while BACKUP_DEST_DIR stays set) must NOT leave
  // a permanent offsite-stale 503 — the offsite alarm is gated on backupsEnabled
  // just like the primary backup-stale/never-ran alarms.
  it("never flags offsite staleness when backups are disabled (#620)", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      backupsEnabled: false,
      stalenessThresholdHours: 48,
      lastBackupAt: null,
      offsiteConfigured: true,
      lastOffsiteAt: "2026-06-01T12:00:00Z", // ancient mirror, but schedule is off
      now,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.httpStatus).toBe(200);
  });
});

// ---- Disk headroom (#1856) ----
//
// The alarm exists because `write-failed` is too late: it fires only once the
// volume already refuses a few bytes. The clause that actually matters here is the
// SNAPSHOT one — the nightly VACUUM INTO writes a whole copy of the database, so a
// volume with a comfortable free PERCENTAGE can still be unable to take a backup,
// and the backup is the first thing that breaks.

const GB = 1024 ** 3;

describe("isDiskLow (#1856)", () => {
  it("is false when the probe could not run — an unrunnable check invents no alarm", () => {
    expect(isDiskLow({ diskFreeBytes: null, diskTotalBytes: 100 * GB })).toBe(
      false
    );
    expect(isDiskLow({})).toBe(false);
    expect(
      isDiskLow({ diskFreeBytes: Number.NaN, diskTotalBytes: 100 * GB })
    ).toBe(false);
  });

  it("flags a volume under the free-share floor, and clears once it is over", () => {
    // 4% free — under the 5% default.
    expect(isDiskLow({ diskFreeBytes: 4 * GB, diskTotalBytes: 100 * GB })).toBe(
      true
    );
    expect(
      isDiskLow({ diskFreeBytes: 40 * GB, diskTotalBytes: 100 * GB })
    ).toBe(false);
    // Exactly at the floor is NOT low — strictly under, so a floor of 5 does not
    // permanently alarm a volume parked at 5%.
    expect(isDiskLow({ diskFreeBytes: 5 * GB, diskTotalBytes: 100 * GB })).toBe(
      false
    );
  });

  it("honours an operator floor, including 0 to switch the free-share clause off", () => {
    const volume = { diskFreeBytes: 4 * GB, diskTotalBytes: 100 * GB };
    expect(isDiskLow({ ...volume, floorPercent: 2 })).toBe(false);
    expect(isDiskLow({ ...volume, floorPercent: 10 })).toBe(true);
    // 0 disables the percentage clause. With backups off there is no other clause,
    // so a nearly-full volume reports fine — which is the operator's stated choice.
    expect(isDiskLow({ ...volume, floorPercent: 0 })).toBe(false);
  });

  it("flags too little room for the next snapshot even when the free SHARE is fine", () => {
    // 10 GB free of 50 GB (20% — nowhere near the percentage floor), but the live
    // database is 9 GB, so VACUUM INTO cannot land its copy.
    const tight = {
      diskFreeBytes: 10 * GB,
      diskTotalBytes: 50 * GB,
      dbSizeBytes: 9 * GB,
    };
    expect(isDiskLow({ ...tight, backupsEnabled: true })).toBe(true);
    // Same volume with a small database: plenty of headroom.
    expect(
      isDiskLow({ ...tight, dbSizeBytes: 1 * GB, backupsEnabled: true })
    ).toBe(false);
  });

  it("skips the snapshot clause when backups are disabled — no VACUUM INTO to fail", () => {
    // The same gate #620 put on offsite-stale: the alarm is about a scheduled
    // snapshot, so it must not fire on an instance that takes none.
    expect(
      isDiskLow({
        diskFreeBytes: 10 * GB,
        diskTotalBytes: 50 * GB,
        dbSizeBytes: 9 * GB,
        backupsEnabled: false,
      })
    ).toBe(false);
  });

  it("skips the snapshot clause when the DB size is unknown", () => {
    expect(
      isDiskLow({
        diskFreeBytes: 10 * GB,
        diskTotalBytes: 50 * GB,
        dbSizeBytes: null,
        backupsEnabled: true,
      })
    ).toBe(false);
  });
});

describe("clampDiskFloorPercent (#1856)", () => {
  it("defaults on absent or unparseable input", () => {
    expect(clampDiskFloorPercent(undefined)).toBe(
      DEFAULT_DISK_FREE_FLOOR_PERCENT
    );
    expect(clampDiskFloorPercent(null)).toBe(DEFAULT_DISK_FREE_FLOOR_PERCENT);
    expect(clampDiskFloorPercent("  ")).toBe(DEFAULT_DISK_FREE_FLOOR_PERCENT);
    expect(clampDiskFloorPercent("plenty")).toBe(
      DEFAULT_DISK_FREE_FLOOR_PERCENT
    );
    expect(clampDiskFloorPercent("-3")).toBe(DEFAULT_DISK_FREE_FLOOR_PERCENT);
  });

  it("takes a real value, allows 0, and caps a typo at 50", () => {
    expect(clampDiskFloorPercent("12")).toBe(12);
    expect(clampDiskFloorPercent("0")).toBe(0);
    // Without the cap, "95" would pin a perfectly healthy instance at 503 forever.
    expect(clampDiskFloorPercent("95")).toBe(50);
  });
});

describe("buildHealthStatus disk precedence (#1856)", () => {
  it("reports disk-low + 503 on a filling volume that still writes fine", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      diskFreeBytes: 1 * GB,
      diskTotalBytes: 100 * GB,
      lastBackupAt: "2026-07-09T06:00:00Z",
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("disk-low");
    expect(r.httpStatus).toBe(503);
  });

  it("keeps the body coarse — the reason word only, no bytes anywhere", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      diskFreeBytes: 1 * GB,
      diskTotalBytes: 100 * GB,
      dbSizeBytes: 40 * GB,
      backupsEnabled: true,
      lastBackupAt: "2026-07-09T06:00:00Z",
      now,
    });
    // This endpoint is unauthenticated. Volume size, free space and database size
    // are all facts about how much health data this instance holds, and none of
    // them may reach the caller.
    expect(Object.keys(r).sort()).toEqual([
      "httpStatus",
      "lastBackupAgeHours",
      "ok",
      "reason",
      "status",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/\d{9,}/);
  });

  it("yields to corruption but outranks the backup alarms", () => {
    const filling = {
      readOk: true,
      writeOk: true,
      diskFreeBytes: 1 * GB,
      diskTotalBytes: 100 * GB,
      backupsEnabled: true,
      stalenessThresholdHours: 48,
      lastBackupAt: "2026-07-01T12:00:00Z", // long stale
      now,
    };
    // Corruption is worse than a filling disk.
    expect(
      buildHealthStatus({ ...filling, liveIntegrityOk: false }).reason
    ).toBe("integrity-failed");
    // But a disk that cannot take a snapshot is the CAUSE the staleness alarm is
    // about to report as an effect — naming the cause helps the operator more.
    expect(buildHealthStatus(filling).reason).toBe("disk-low");
  });

  it("stays ok + 200 on a healthy volume — the default install must not 503", () => {
    const r = buildHealthStatus({
      readOk: true,
      writeOk: true,
      diskFreeBytes: 60 * GB,
      diskTotalBytes: 100 * GB,
      dbSizeBytes: 200 * 1024 * 1024,
      backupsEnabled: true,
      lastBackupAt: "2026-07-09T06:00:00Z",
      now,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.httpStatus).toBe(200);
  });
});
