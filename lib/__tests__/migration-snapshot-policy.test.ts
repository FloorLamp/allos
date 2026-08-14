// PURE TIER. The pre-flight migration snapshot's policy (#2702): when a snapshot
// is taken, what it is called, which ones are removed, and how much room it needs.
// No fs, no DB — the executing half is exercised in
// lib/__db_tests__/migration-snapshot.test.ts.

import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  MIGRATION_SNAPSHOT_KEEP,
  MIGRATION_SNAPSHOT_MAX_AGE_DAYS,
  hasSnapshotHeadroom,
  matchesPreState,
  migrationSidecarName,
  migrationSnapshotDir,
  migrationSnapshotName,
  parseMigrationSnapshotName,
  planMigrationSnapshotPrune,
  requiredSnapshotBytes,
  shouldSnapshotBeforeMigrations,
  snapshotDisabledByEnv,
  type PreMigrationSnapshotMeta,
} from "@/lib/migrations/snapshot-policy";
import { parseBackupStamp } from "@/lib/backup-rotation";
import { BACKUP_SNAPSHOT_HEADROOM_FACTOR } from "@/lib/health-status";
import { verificationSidecarName } from "@/lib/backup-verify";

const at = (iso: string): Date => new Date(iso);

describe("the trigger — an upgrade is happening, not a delete is pending", () => {
  const base = {
    dbPath: "/app/data/allos.db",
    disabled: false,
    pendingCount: 3,
    appliedCount: 190,
  };

  it("takes one when a populated database has migrations pending", () => {
    expect(shouldSnapshotBeforeMigrations(base)).toEqual({ take: true });
  });

  it("skips the boot that dominates: nothing pending", () => {
    expect(
      shouldSnapshotBeforeMigrations({ ...base, pendingCount: 0 })
    ).toEqual({ take: false, reason: "nothing-pending" });
  });

  it("skips a fresh install — an empty ledger means there are no rows to lose", () => {
    expect(
      shouldSnapshotBeforeMigrations({ ...base, appliedCount: 0 })
    ).toEqual({ take: false, reason: "fresh-install" });
  });

  it("skips a database with no file behind it", () => {
    for (const dbPath of [":memory:", "", "  "]) {
      expect(shouldSnapshotBeforeMigrations({ ...base, dbPath })).toEqual({
        take: false,
        reason: "in-memory",
      });
    }
  });

  it("the operator opt-out wins over everything else", () => {
    expect(shouldSnapshotBeforeMigrations({ ...base, disabled: true })).toEqual(
      {
        take: false,
        reason: "disabled",
      }
    );
  });

  it("nothing-pending is decided before the in-memory skip, so an idle boot never asks about paths", () => {
    // Both would skip; the reason must name the ordinary case, because that is the
    // one an operator reading a log needs to recognise as normal.
    expect(
      shouldSnapshotBeforeMigrations({
        ...base,
        dbPath: ":memory:",
        pendingCount: 0,
      })
    ).toEqual({ take: false, reason: "nothing-pending" });
  });
});

describe("the operator opt-out", () => {
  it("recognises the documented spellings and nothing else", () => {
    for (const on of ["off", "OFF", " off ", "0", "false", "no"]) {
      expect(snapshotDisabledByEnv(on)).toBe(true);
    }
    for (const off of [
      undefined,
      null,
      "",
      "on",
      "1",
      "true",
      "yes",
      "maybe",
    ]) {
      expect(snapshotDisabledByEnv(off)).toBe(false);
    }
  });
});

describe("filenames", () => {
  it("round-trips a UTC instant", () => {
    const name = migrationSnapshotName(at("2026-08-14T09:07:05.400Z"));
    expect(name).toBe("allos-premigrate-2026-08-14-090705.db");
    const parsed = parseMigrationSnapshotName(name);
    expect(parsed?.atMs).toBe(Date.parse("2026-08-14T09:07:05Z"));
  });

  it("is visible to the restore tooling's listing filter but never to the rotation planner", () => {
    const name = migrationSnapshotName(at("2026-08-14T09:07:05Z"));
    // listBackupNames' filter, so `npm run restore -- --from <dir>` lists it.
    expect(name.startsWith("allos-")).toBe(true);
    expect(name.endsWith(".db")).toBe(true);
    // parseBackupStamp's shape, so planBackupRotation and getLastBackup can never
    // mistake it for a scheduled snapshot (or prune it as one).
    expect(parseBackupStamp(name)).toBeNull();
  });

  it("ignores anything that is not one of ours", () => {
    for (const other of [
      "allos-2026-08-14-0907.db",
      "allos-premigrate-2026-08-14-0907.db", // no seconds
      "allos-premigrate-2026-08-14-090705.db.json",
      "notes.txt",
    ]) {
      expect(parseMigrationSnapshotName(other)).toBeNull();
    }
  });

  it("the two sidecars are distinct files and neither ends in .db", () => {
    const name = "allos-premigrate-2026-08-14-090705.db";
    expect(migrationSidecarName(name)).not.toBe(verificationSidecarName(name));
    expect(migrationSidecarName(name).endsWith(".db")).toBe(false);
    expect(verificationSidecarName(name).endsWith(".db")).toBe(false);
  });
});

describe("retention", () => {
  const names = [
    "allos-premigrate-2026-08-14-090705.db",
    "allos-premigrate-2026-08-10-120000.db",
    "allos-premigrate-2026-08-01-120000.db",
    "allos-premigrate-2026-05-01-120000.db",
  ];
  const now = at("2026-08-14T10:00:00Z");

  it("keeps the newest N and prunes the rest", () => {
    expect(
      planMigrationSnapshotPrune(names.slice(0, 3), { keep: 2, now })
    ).toEqual(["allos-premigrate-2026-08-01-120000.db"]);
  });

  it("prunes past the age cap even inside the keep window", () => {
    // The May file is within the newest 2 of this pair, and still goes.
    expect(
      planMigrationSnapshotPrune(
        ["allos-premigrate-2026-08-14-090705.db", names[3]],
        { keep: 2, now }
      )
    ).toEqual([names[3]]);
  });

  it("the age cap can empty the directory — a copy protecting last year's upgrade is pure cost", () => {
    expect(planMigrationSnapshotPrune([names[3]], { keep: 2, now })).toEqual([
      names[3],
    ]);
  });

  it("keep-1 (the runner's pre-copy prune) leaves room for the one about to be written", () => {
    const prune = planMigrationSnapshotPrune(names.slice(0, 2), {
      keep: MIGRATION_SNAPSHOT_KEEP - 1,
      now,
    });
    expect(prune).toEqual(["allos-premigrate-2026-08-10-120000.db"]);
  });

  it("never touches a file it did not write", () => {
    expect(
      planMigrationSnapshotPrune(
        ["allos-2026-01-01-0300.db", "allos.db", "README"],
        { keep: 0, now }
      )
    ).toEqual([]);
  });

  it("sorts by stamp, not by directory order", () => {
    const shuffled = [names[2], names[0], names[3], names[1]];
    expect(planMigrationSnapshotPrune(shuffled, { keep: 1, now })).toEqual([
      names[1],
      names[2],
      names[3],
    ]);
  });

  it("the declared cap is a short useful life, not an archive", () => {
    expect(MIGRATION_SNAPSHOT_KEEP).toBe(2);
    expect(MIGRATION_SNAPSHOT_MAX_AGE_DAYS).toBe(30);
  });
});

describe("crash-loop reuse", () => {
  const meta: PreMigrationSnapshotMeta = {
    takenAt: "2026-08-14T09:07:05.000Z",
    fromUserVersion: 190,
    appliedCount: 190,
    pending: ["20260814-a", "20260814-b"],
    bytes: 1024,
  };
  const state = {
    fromUserVersion: 190,
    appliedCount: 190,
    pending: ["20260814-a", "20260814-b"],
  };

  it("matches the identical pending set", () => {
    expect(matchesPreState(meta, state)).toBe(true);
  });

  it("refuses once anything about the pre-state has moved", () => {
    expect(matchesPreState(null, state)).toBe(false);
    expect(matchesPreState(meta, { ...state, fromUserVersion: 191 })).toBe(
      false
    );
    expect(matchesPreState(meta, { ...state, appliedCount: 191 })).toBe(false);
    // A partial application: one of the two landed, so the pre-state is different
    // and the older copy no longer describes it.
    expect(matchesPreState(meta, { ...state, pending: ["20260814-b"] })).toBe(
      false
    );
    // Same length, different order — a merge reordered the registry.
    expect(
      matchesPreState(meta, { ...state, pending: ["20260814-b", "20260814-a"] })
    ).toBe(false);
  });
});

describe("headroom", () => {
  it("needs a whole database plus the shared slack factor", () => {
    expect(requiredSnapshotBytes(1000)).toBe(
      Math.ceil(1000 * BACKUP_SNAPSHOT_HEADROOM_FACTOR)
    );
  });

  it("refuses when the volume cannot hold the copy", () => {
    expect(hasSnapshotHeadroom({ freeBytes: 1000, dbSizeBytes: 1000 })).toEqual(
      {
        ok: false,
        needBytes: requiredSnapshotBytes(1000),
      }
    );
  });

  it("allows it with room to spare", () => {
    expect(
      hasSnapshotHeadroom({ freeBytes: 10_000, dbSizeBytes: 1000 }).ok
    ).toBe(true);
  });

  it("a probe that could not run is not evidence of a problem", () => {
    expect(hasSnapshotHeadroom({ freeBytes: null, dbSizeBytes: 1000 }).ok).toBe(
      true
    );
    expect(hasSnapshotHeadroom({ freeBytes: NaN, dbSizeBytes: 1000 }).ok).toBe(
      true
    );
  });
});

describe("where snapshots live", () => {
  it("is a subdirectory of the production backups tree", () => {
    // backupsDir() is <cwd>/data/backups; the live DB is <cwd>/data/allos.db. The
    // snapshot dir must sit UNDER that, where listBackupNames (a .db FILE filter)
    // cannot see it.
    const cwd = "/app";
    const dir = migrationSnapshotDir(path.join(cwd, "data", "allos.db"));
    expect(dir).toBe(path.join(cwd, "data", "backups", "pre-migration"));
  });

  it("follows the database when ALLOS_DB_PATH redirects it", () => {
    expect(migrationSnapshotDir("/srv/other/health.db")).toBe(
      path.join("/srv/other", "backups", "pre-migration")
    );
  });

  it("honours an explicit override, and treats blank as unset", () => {
    expect(
      migrationSnapshotDir("/app/data/allos.db", "/mnt/nas/premigrate")
    ).toBe("/mnt/nas/premigrate");
    expect(migrationSnapshotDir("/app/data/allos.db", "   ")).toBe(
      path.join("/app/data", "backups", "pre-migration")
    );
    expect(migrationSnapshotDir("/app/data/allos.db", null)).toBe(
      path.join("/app/data", "backups", "pre-migration")
    );
  });
});
