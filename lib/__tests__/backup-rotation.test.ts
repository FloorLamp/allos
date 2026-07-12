import { describe, it, expect } from "vitest";
import {
  backupFilename,
  parseBackupStamp,
  isoWeekKey,
  planBackupRotation,
  planAsidePrune,
  isBackupDue,
} from "../backup-rotation";

describe("backupFilename / parseBackupStamp", () => {
  it("builds and round-trips a snapshot name", () => {
    const name = backupFilename("2026-07-06", "03:05");
    expect(name).toBe("allos-2026-07-06-0305.db");
    const s = parseBackupStamp(name);
    expect(s?.date).toBe("2026-07-06");
    expect(s?.sort).toBe("2026-07-06-0305");
  });

  it("rejects non-snapshot filenames", () => {
    expect(parseBackupStamp("allos.db")).toBeNull();
    expect(parseBackupStamp("random.db")).toBeNull();
    expect(parseBackupStamp("allos-2026-07-06.db")).toBeNull();
  });
});

describe("isoWeekKey", () => {
  it("matches known ISO-week boundaries", () => {
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01"); // Thursday → week 1
    expect(isoWeekKey("2026-01-05")).toBe("2026-W02"); // Monday of week 2
    expect(isoWeekKey("2025-12-29")).toBe("2026-W01"); // Monday belongs to 2026-W01
  });
});

describe("planBackupRotation", () => {
  // Newest first; n2 and n3 share ISO week 2026-W27.
  const names = [
    "allos-2026-07-06-0300.db", // W28
    "allos-2026-07-05-0300.db", // W27
    "allos-2026-07-04-0300.db", // W27
    "allos-2026-06-28-0300.db", // W26
    "allos-2026-06-21-0300.db", // W25
    "allos-2026-06-14-0300.db", // W24
  ];

  it("keeps N dailies then the newest of the next M weeks", () => {
    const { keep, prune } = planBackupRotation(names, {
      keepDaily: 2,
      keepWeekly: 2,
    });
    expect(prune).toEqual([
      "allos-2026-06-21-0300.db",
      "allos-2026-06-14-0300.db",
    ]);
    expect(keep).toContain("allos-2026-07-06-0300.db");
    expect(keep).toContain("allos-2026-07-04-0300.db"); // weekly for W27
    expect(keep).toContain("allos-2026-06-28-0300.db"); // weekly for W26
  });

  it("prunes everything when retention is zero", () => {
    const { keep, prune } = planBackupRotation(names, {
      keepDaily: 0,
      keepWeekly: 0,
    });
    expect(keep).toEqual([]);
    expect(prune).toHaveLength(names.length);
  });

  it("never touches foreign files", () => {
    const { keep, prune } = planBackupRotation(
      [...names, "notes.txt", "backup.sql"],
      { keepDaily: 1, keepWeekly: 0 }
    );
    expect(keep).not.toContain("notes.txt");
    expect(prune).not.toContain("notes.txt");
    expect(prune).not.toContain("backup.sql");
  });

  it("keeps a single daily when that's all there is", () => {
    const { keep, prune } = planBackupRotation(["allos-2026-07-06-0300.db"], {
      keepDaily: 7,
      keepWeekly: 8,
    });
    expect(keep).toEqual(["allos-2026-07-06-0300.db"]);
    expect(prune).toEqual([]);
  });
});

describe("planAsidePrune (#472)", () => {
  const base = "allos.db";
  const asides = [
    "allos.db.pre-restore-2026-07-08T03-00-00-000Z",
    "allos.db.pre-restore-2026-07-09T03-00-00-000Z",
    "allos.db.pre-restore-2026-07-10T03-00-00-000Z",
    "allos.db.pre-restore-2026-07-11T03-00-00-000Z",
  ];

  it("keeps the newest keepN and prunes the rest (oldest first)", () => {
    expect(planAsidePrune(asides, base, 2)).toEqual([
      "allos.db.pre-restore-2026-07-08T03-00-00-000Z",
      "allos.db.pre-restore-2026-07-09T03-00-00-000Z",
    ]);
  });

  it("prunes nothing when there are keepN or fewer", () => {
    expect(planAsidePrune(asides.slice(0, 2), base, 3)).toEqual([]);
  });

  it("ignores -wal/-shm siblings and foreign/live files", () => {
    const names = [
      ...asides,
      "allos.db.pre-restore-2026-07-11T03-00-00-000Z-wal",
      "allos.db.pre-restore-2026-07-11T03-00-00-000Z-shm",
      "allos.db",
      "allos.db-wal",
      "allos-2026-07-11-0300.db", // a snapshot, not an aside
    ];
    // Only the 4 main asides count; keepN=1 → prune the 3 oldest mains.
    expect(planAsidePrune(names, base, 1)).toEqual([
      "allos.db.pre-restore-2026-07-08T03-00-00-000Z",
      "allos.db.pre-restore-2026-07-09T03-00-00-000Z",
      "allos.db.pre-restore-2026-07-10T03-00-00-000Z",
    ]);
  });

  it("only considers asides of the given live DB basename", () => {
    const names = [
      "allos.db.pre-restore-2026-07-08T03-00-00-000Z",
      "other.db.pre-restore-2026-07-09T03-00-00-000Z",
    ];
    expect(planAsidePrune(names, base, 0)).toEqual([
      "allos.db.pre-restore-2026-07-08T03-00-00-000Z",
    ]);
  });
});

describe("isBackupDue", () => {
  const cfg = { enabled: true, hour: 3 };

  it("is due at the configured hour when none taken today", () => {
    expect(isBackupDue(cfg, 3, undefined, "2026-07-06")).toBe(true);
  });

  it("retries in the following hour (matches notify slot window)", () => {
    expect(isBackupDue(cfg, 4, undefined, "2026-07-06")).toBe(true);
  });

  it("is not due outside the window", () => {
    expect(isBackupDue(cfg, 5, undefined, "2026-07-06")).toBe(false);
    expect(isBackupDue(cfg, 2, undefined, "2026-07-06")).toBe(false);
  });

  it("is not due once one has been taken today", () => {
    expect(isBackupDue(cfg, 3, "2026-07-06", "2026-07-06")).toBe(false);
  });

  it("is never due when disabled", () => {
    expect(
      isBackupDue({ enabled: false, hour: 3 }, 3, undefined, "2026-07-06")
    ).toBe(false);
  });
});
