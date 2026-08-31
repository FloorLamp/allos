import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allocateUxServedDb,
  assertUxServedDbOwned,
  assertUxServedDbUnused,
  cleanupUxServedDb,
} from "../../scripts/ux-served-db.mjs";
import { makeTmpDir } from "../__tests__/tmp-dir";
import { perTestCeiling } from "../../vitest.timeouts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

function runSeed(dbPath: string) {
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
        SEED_DIAL_SHAPE: "one-cycle",
        SEED_RNG: "",
        SEED_PERSONA: "",
        UX_SEED: "one-cycle",
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

// ONE CEILING FOR THE FILE, AND IT IS A MULTIPLE — same reasoning as
// dirty-seed-shape.test.ts, whose spawn-a-real-seed shape this file shares
// (#3986). A hard-coded `}, 30_000)` is immune to `ALLOS_VITEST_TIMEOUT_MS`, so
// the one lever the harness offers did not reach the specs that block on real
// child processes. Named rather than inline only so the `describe` line still fits.
const SPAWN_CEILING = { timeout: perTestCeiling(3, "worst") };

describe("named one-cycle seed data (#3489 D5)", SPAWN_CEILING, () => {
  it("seeds the honest UI state and passes the production verifier", () => {
    const allocation = allocateUxServedDb(
      makeTmpDir("one-cycle-owned-database")
    );
    try {
      assertUxServedDbUnused(allocation);
      const seeded = runSeed(allocation.dbPath);
      expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
      assertUxServedDbOwned(allocation);

      const verified = runVerifier(allocation.dbPath);
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
      expect(verified.stdout).toContain("verified one-cycle UX database");
      assertUxServedDbOwned(allocation);
    } finally {
      cleanupUxServedDb(allocation);
    }
  });
});
