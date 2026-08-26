import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  cycleLengths,
  cycleLengthStatsState,
  cycleStats,
  type CyclePeriod,
} from "../cycle";
import {
  allocateUxServedDb,
  assertUxServedDbOwned,
  assertUxServedDbUnused,
  cleanupUxServedDb,
} from "../../scripts/ux-served-db.mjs";
import { makeTmpDir } from "../__tests__/tmp-dir";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

function runSeed(dbPath: string, shape: "baseline" | "one-cycle") {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repo, "scripts", "seed.ts")],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOS_DB_PATH: dbPath,
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "first-boot-pw-1",
        SEED_DIAL_SHAPE: shape === "one-cycle" ? "one-cycle" : "",
        SEED_RNG: shape === "baseline" ? "1" : "",
        SEED_PERSONA: "",
        UX_SEED: shape === "one-cycle" ? "one-cycle" : "1",
      },
    }
  );
}

function runVerifier(dbPath: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repo, "scripts", "verify-ux-seed-shape.ts")],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOS_DB_PATH: dbPath,
        UX_OWNED_DB_DIR: path.dirname(dbPath),
        UX_SEED: "one-cycle",
      },
    }
  );
}

function readPeriods(dbPath: string): CyclePeriod[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id, period_start, period_end, flow, note
           FROM cycles
          WHERE profile_id = 1
          ORDER BY period_start, id`
      )
      .all() as CyclePeriod[];
  } finally {
    db.close();
  }
}

describe("named one-cycle seed data (#3489 D5)", () => {
  it("seeds two periods, verifies one interval, and reaches the honest UI state", () => {
    const allocation = allocateUxServedDb(
      makeTmpDir("one-cycle-owned-database")
    );
    try {
      assertUxServedDbUnused(allocation);
      const seeded = runSeed(allocation.dbPath, "one-cycle");
      expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
      assertUxServedDbOwned(allocation);

      const periods = readPeriods(allocation.dbPath);
      expect(periods).toHaveLength(2);
      expect(periods.every((period) => period.period_end != null)).toBe(true);
      expect(cycleLengths(periods)).toEqual([
        expect.objectContaining({ days: 28 }),
      ]);
      const stats = cycleStats(periods);
      expect(stats.cycleCount).toBe(1);
      expect(stats.regularity).toBe("insufficient");
      expect(cycleLengthStatsState(stats)).toEqual({
        kind: "insufficient",
        message: "1 completed cycle — cycle length stats appear after 3.",
      });

      const verified = runVerifier(allocation.dbPath);
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
      expect(verified.stdout).toContain("verified one-cycle UX database");
      assertUxServedDbOwned(allocation);
    } finally {
      cleanupUxServedDb(allocation);
    }
  }, 30_000);

  it("makes both off-by-one mutations fail loudly at the real verifier boundary", () => {
    const allocation = allocateUxServedDb(
      makeTmpDir("one-cycle-verifier-mutations")
    );
    try {
      const seeded = runSeed(allocation.dbPath, "one-cycle");
      expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
      const exact = fs.readFileSync(allocation.dbPath);

      let db = new Database(allocation.dbPath);
      db.prepare(
        "DELETE FROM cycles WHERE profile_id = 1 AND period_start = (SELECT MAX(period_start) FROM cycles WHERE profile_id = 1)"
      ).run();
      db.close();
      const tooFew = runVerifier(allocation.dbPath);
      expect(tooFew.status).not.toBe(0);
      expect(tooFew.stderr).toContain("storedPeriods=1");
      expect(tooFew.stderr).toContain("completedIntervals=0");

      fs.writeFileSync(allocation.dbPath, exact);
      db = new Database(allocation.dbPath);
      db.prepare(
        `INSERT INTO cycles
           (profile_id, period_start, period_end, flow, note)
         VALUES (1, '2026-01-01', '2026-01-05', 'medium', NULL)`
      ).run();
      db.close();
      const tooMany = runVerifier(allocation.dbPath);
      expect(tooMany.status).not.toBe(0);
      expect(tooMany.stderr).toContain("storedPeriods=3");
      expect(tooMany.stderr).toContain("completedIntervals=2");

      fs.writeFileSync(allocation.dbPath, exact);
      const restored = runVerifier(allocation.dbPath);
      expect(restored.status, restored.stderr || restored.stdout).toBe(0);
    } finally {
      cleanupUxServedDb(allocation);
    }
  }, 30_000);

  it("rejects a baseline database mislabeled as one-cycle", () => {
    const allocation = allocateUxServedDb(
      makeTmpDir("one-cycle-label-mismatch")
    );
    try {
      const seeded = runSeed(allocation.dbPath, "baseline");
      expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
      const mislabeled = runVerifier(allocation.dbPath);
      expect(mislabeled.status).not.toBe(0);
      expect(mislabeled.stderr).toContain(
        "One-cycle seed witnesses do not match"
      );
      expect(mislabeled.stderr).toContain("storedPeriods=4");
    } finally {
      cleanupUxServedDb(allocation);
    }
  }, 30_000);
});
