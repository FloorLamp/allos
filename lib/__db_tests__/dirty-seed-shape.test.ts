import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LONG_NAMES } from "../../scripts/seed-long-names";
import { makeTmpDir } from "../__tests__/tmp-dir";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

type Witnesses = {
  qualifiedEncounter: number;
  longIntake: number;
  longLab: number;
  longCondition: number;
};

function seedAndRead(shape: "baseline" | "dirty"): Witnesses {
  const dbPath = path.join(makeTmpDir(`seed-shape-${shape}`), "allos.db");
  const env = {
    ...process.env,
    ALLOS_DB_PATH: dbPath,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "first-boot-pw-1",
    SEED_DIAL_SHAPE: shape === "dirty" ? "dirty" : "",
    SEED_RNG: shape === "baseline" ? "1" : "",
    SEED_PERSONA: "",
    UX_SEED: "",
  };
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repo, "scripts", "seed.ts")],
    { cwd: repo, env, encoding: "utf8" }
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (sql: string, value: string) =>
      (db.prepare(sql).get(value) as { count: number }).count;
    return {
      qualifiedEncounter: count(
        "SELECT COUNT(*) AS count FROM encounters WHERE profile_id = 1 AND diagnoses = ?",
        "Encounter for screening for malignant neoplasm of colon; Encounter for screening for malignant neoplasm of colon - Primary"
      ),
      longIntake: count(
        "SELECT COUNT(*) AS count FROM intake_items WHERE profile_id = 1 AND name = ?",
        LONG_NAMES.intakeItem
      ),
      longLab: count(
        "SELECT COUNT(*) AS count FROM medical_records WHERE profile_id = 1 AND category = 'lab' AND name = ?",
        LONG_NAMES.clinicalResult
      ),
      longCondition: count(
        "SELECT COUNT(*) AS count FROM conditions WHERE profile_id = 1 AND name = ?",
        LONG_NAMES.condition
      ),
    };
  } finally {
    db.close();
  }
}

describe("named dirty seed data", () => {
  it("writes the dirty witnesses through seed.ts while the pinned baseline writes none", () => {
    expect(seedAndRead("dirty")).toEqual({
      qualifiedEncounter: 1,
      longIntake: 1,
      longLab: 1,
      longCondition: 1,
    });
    expect(seedAndRead("baseline")).toEqual({
      qualifiedEncounter: 0,
      longIntake: 0,
      longLab: 0,
      longCondition: 0,
    });
  }, 30_000);
});
