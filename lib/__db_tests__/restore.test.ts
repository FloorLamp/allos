// DB INTEGRATION TIER — the restore drill (#462).
//
// Before this, NOTHING in any test tier executed scripts/restore.ts's core copy
// sequence or a real VACUUM INTO snapshot — the last line of defense first ran
// mid-disaster. This drives the extracted restoreCore (lib/restore.ts) against a
// REAL VACUUM INTO snapshot of the migrated schema: verify → aside → install →
// WAL cleanup → post-integrity, plus the failure legs (integrity refusal without
// --force, --force override, and --from path confinement).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { db, dbFilePath } from "@/lib/db";
import {
  performBackup,
  backupsDir,
  verifySnapshot,
  pruneRestoreAsides,
} from "@/lib/backup";
import { verificationSidecarName } from "@/lib/backup-verify";
import {
  confineSnapshotPath,
  restoreCore,
  RestoreRefusedError,
} from "@/lib/restore";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allos-restore-drill-"));
}

// Take a real VACUUM INTO snapshot of the live (migrated) singleton DB to `dest`.
function snapshotTo(dest: string): void {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

// Whether the settings key exists in the DB at `p` (read-only probe).
function hasSetting(p: string, key: string): boolean {
  const h = new Database(p, { readonly: true, fileMustExist: true });
  try {
    const row = h.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row !== undefined;
  } finally {
    h.close();
  }
}

describe("restoreCore (restore drill)", () => {
  let tmp: string;
  let snap: string;
  let live: string;
  const marker = "drill-marker-462";

  beforeEach(() => {
    tmp = mkTmp();
    snap = path.join(tmp, "snap.db");
    live = path.join(tmp, "live.db");

    // 1. Real VACUUM INTO snapshot of the migrated schema (state S0, no marker).
    snapshotTo(snap);

    // 2. Seed the "live" DB from the snapshot, then MUTATE it (state S0 + marker)
    //    in rollback (DELETE) journal mode so the write lands in the main file.
    fs.copyFileSync(snap, live);
    const h = new Database(live);
    h.pragma("journal_mode = DELETE");
    h.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(marker);
    h.close();

    // Stale -wal/-shm sidecars that a restore must clear so the next boot can't
    // replay an old WAL over the restored file.
    fs.writeFileSync(live + "-wal", "stale-wal");
    fs.writeFileSync(live + "-shm", "stale-shm");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("installs the snapshot, cleans WAL/SHM, and captures the pre-restore aside", () => {
    // Sanity: the snapshot verifies ok as a real SQLite file (not a literal string).
    const h = new Database(snap, { readonly: true, fileMustExist: true });
    try {
      expect(h.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      h.close();
    }

    const now = new Date("2026-07-12T04:00:00Z");
    const result = restoreCore({
      snapshotPath: snap,
      livePath: live,
      snapshotOk: true,
      force: false,
      now,
    });

    // The mutation is gone — live now matches the pre-mutation snapshot.
    expect(hasSetting(live, marker)).toBe(false);

    // Stale WAL/SHM cleaned.
    expect(fs.existsSync(live + "-wal")).toBe(false);
    expect(fs.existsSync(live + "-shm")).toBe(false);

    // The aside exists and holds the PRE-restore (mutated) state — a real rollback.
    expect(result.asidePath).toBeTruthy();
    expect(fs.existsSync(result.asidePath as string)).toBe(true);
    expect(hasSetting(result.asidePath as string, marker)).toBe(true);
  });

  it("refuses an integrity-failed snapshot without --force (no aside written)", () => {
    const before = fs.readdirSync(tmp).length;
    expect(() =>
      restoreCore({
        snapshotPath: snap,
        livePath: live,
        snapshotOk: false,
        force: false,
      })
    ).toThrow(RestoreRefusedError);

    // Live untouched, no aside created.
    expect(hasSetting(live, marker)).toBe(true);
    expect(fs.readdirSync(tmp).length).toBe(before);
  });

  it("--force overrides the integrity refusal and installs anyway", () => {
    const result = restoreCore({
      snapshotPath: snap,
      livePath: live,
      snapshotOk: false,
      force: true,
      now: new Date("2026-07-12T04:00:00Z"),
    });
    expect(result.asidePath).toBeTruthy();
    expect(hasSetting(live, marker)).toBe(false);
  });

  it("installs via an atomic swap — no .restore-tmp is left behind (#472)", () => {
    restoreCore({
      snapshotPath: snap,
      livePath: live,
      snapshotOk: true,
      force: false,
      now: new Date("2026-07-12T04:00:00Z"),
    });
    expect(fs.existsSync(live + ".restore-tmp")).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  it("copies the live -wal/-shm alongside the aside (WAL-aware rollback, #472)", () => {
    const result = restoreCore({
      snapshotPath: snap,
      livePath: live,
      snapshotOk: true,
      force: false,
      now: new Date("2026-07-12T04:00:00Z"),
    });
    // The stale WAL/SHM present pre-restore are preserved in the aside, so a
    // rollback can recover WAL-only committed transactions.
    expect(fs.readFileSync((result.asidePath as string) + "-wal", "utf8")).toBe(
      "stale-wal"
    );
    expect(fs.readFileSync((result.asidePath as string) + "-shm", "utf8")).toBe(
      "stale-shm"
    );
  });

  it("refuses a newer-schema snapshot without --force, and installs with it (#472)", () => {
    expect(() =>
      restoreCore({
        snapshotPath: snap,
        livePath: live,
        snapshotOk: true,
        force: false,
        snapshotUserVersion: 999,
        buildMigrationCount: 1,
      })
    ).toThrow(RestoreRefusedError);
    // Live untouched by the refusal.
    expect(hasSetting(live, marker)).toBe(true);

    // --force installs it anyway.
    const result = restoreCore({
      snapshotPath: snap,
      livePath: live,
      snapshotOk: true,
      force: true,
      snapshotUserVersion: 999,
      buildMigrationCount: 1,
      now: new Date("2026-07-12T04:00:00Z"),
    });
    expect(result.asidePath).toBeTruthy();
    expect(hasSetting(live, marker)).toBe(false);
  });

  it("performBackup takes a real, integrity-verified VACUUM INTO snapshot", () => {
    const { name, verification } = performBackup();
    try {
      expect(verification.integrity).toBe("ok");
      expect(fs.existsSync(path.join(backupsDir(), name))).toBe(true);
      // Re-verify the on-disk snapshot independently.
      expect(verifySnapshot(name).integrity).toBe("ok");
    } finally {
      // Keep the repo's data/backups clean — remove what this test wrote.
      fs.rmSync(path.join(backupsDir(), name), { force: true });
      fs.rmSync(path.join(backupsDir(), verificationSidecarName(name)), {
        force: true,
      });
    }
  });
});

describe("pruneRestoreAsides (#472)", () => {
  it("keeps the newest N asides next to the live DB and removes their sidecars", () => {
    const livePath = dbFilePath();
    const stamps = [
      "2026-07-08T03-00-00-000Z",
      "2026-07-09T03-00-00-000Z",
      "2026-07-10T03-00-00-000Z",
      "2026-07-11T03-00-00-000Z",
    ];
    const created: string[] = [];
    for (const s of stamps) {
      const aside = `${livePath}.pre-restore-${s}`;
      fs.writeFileSync(aside, "x");
      fs.writeFileSync(aside + "-wal", "w");
      created.push(aside);
    }
    try {
      const pruned = pruneRestoreAsides(2);
      expect(pruned).toBe(2);
      // Two oldest gone (main + -wal sidecar).
      expect(fs.existsSync(created[0])).toBe(false);
      expect(fs.existsSync(created[0] + "-wal")).toBe(false);
      expect(fs.existsSync(created[1])).toBe(false);
      // Two newest kept.
      expect(fs.existsSync(created[2])).toBe(true);
      expect(fs.existsSync(created[3])).toBe(true);
    } finally {
      for (const a of created) {
        fs.rmSync(a, { force: true });
        fs.rmSync(a + "-wal", { force: true });
      }
    }
  });
});

describe("confineSnapshotPath (--from path confinement)", () => {
  it("resolves a bare filename inside the source dir", () => {
    expect(
      confineSnapshotPath("/data/backups", "allos-2026-07-10-0300.db")
    ).toBe(path.resolve("/data/backups", "allos-2026-07-10-0300.db"));
  });

  it("refuses a ../ escape", () => {
    expect(confineSnapshotPath("/data/backups", "../../etc/passwd")).toBeNull();
  });

  it("refuses an absolute path outside the dir", () => {
    expect(confineSnapshotPath("/data/backups", "/etc/passwd")).toBeNull();
  });

  it("refuses the directory itself", () => {
    expect(confineSnapshotPath("/data/backups", ".")).toBeNull();
  });
});
