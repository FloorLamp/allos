import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LONG_NAMES } from "../../scripts/seed-long-names";
import { makeTmpDir } from "../__tests__/tmp-dir";
import { migratedDb } from "./migrated-db";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

type Witnesses = {
  qualifiedEncounter: number;
  longIntake: number;
  longLab: number;
  longCondition: number;
};

function runSeed(dbPath: string, shape: "baseline" | "dirty") {
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
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repo, "scripts", "seed.ts")],
    { cwd: repo, env, encoding: "utf8" }
  );
}

function seedAndRead(shape: "baseline" | "dirty"): Witnesses {
  const dbPath = path.join(makeTmpDir(`seed-shape-${shape}`), "allos.db");
  const result = runSeed(dbPath, shape);
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

function migratedFile(
  label: string,
  mutate: (database: Database.Database) => void
): string {
  const dbPath = path.join(
    makeTmpDir(`seed-shape-${label.replaceAll("_", "-")}`),
    "allos.db"
  );
  const source = migratedDb();
  try {
    mutate(source);
    fs.writeFileSync(dbPath, source.serialize());
  } finally {
    source.close();
  }
  return dbPath;
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

  it("rejects every standard census shape when its scratch DB is stale", () => {
    const dir = makeTmpDir("seed-shape-stale");
    const dbPath = path.join(dir, "allos.db");
    const baseline = runSeed(dbPath, "baseline");
    expect(baseline.status, baseline.stderr || baseline.stdout).toBe(0);

    const directDirty = runSeed(dbPath, "dirty");
    expect(directDirty.status).not.toBe(0);
    expect(directDirty.stderr).toContain(
      "Database already has data — refusing named seed shape dirty"
    );

    for (const [uxSeed, label] of [
      ["", "fresh"],
      ["1", "seeded"],
      ["thin", "thin"],
      ["dirty", "dirty"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.join(repo, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            ALLOS_DB_PATH: dbPath,
            UX_SHOTS: path.join(dir, `shots-${uxSeed}`),
            UX_SEED: uxSeed,
            SEED_RNG: "",
            SEED_PERSONA: "",
            SEED_DIAL_SHAPE: "",
          },
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `refusing to reuse it for the ${label} census shape`
      );
    }
  }, 30_000);

  it.each([
    [
      "a profile-owned condition",
      "conditions",
      (database: Database.Database) =>
        database
          .prepare(
            "INSERT INTO conditions (profile_id, name, status) VALUES (1, 'Stale sentinel condition', 'active')"
          )
          .run(),
    ],
    [
      "global provider data",
      "providers",
      (database: Database.Database) =>
        database
          .prepare(
            "INSERT INTO providers (name, type, dedup_key) VALUES ('Stale provider', 'organization', 'stale-provider')"
          )
          .run(),
    ],
    [
      "a changed profile setting",
      "profile_settings",
      (database: Database.Database) =>
        database
          .prepare(
            "INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'sex', 'female')"
          )
          .run(),
    ],
  ])(
    "refuses dirty seeding over %s through the real seed path",
    (_label, table, mutate) => {
      const dbPath = migratedFile(table, mutate);
      const result = runSeed(dbPath, "dirty");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Database already has data — refusing named seed shape dirty"
      );
      expect(result.stderr).toContain(`${table} (`);

      const database = new Database(dbPath, { readonly: true });
      try {
        const dirtyWitness = database
          .prepare(
            "SELECT COUNT(*) count FROM intake_items WHERE profile_id = 1 AND name = ?"
          )
          .get(LONG_NAMES.intakeItem) as { count: number };
        expect(dirtyWitness.count).toBe(0);
      } finally {
        database.close();
      }
    }
  );

  it("aborts when the real thin post-seed child fails", () => {
    const dir = makeTmpDir("seed-shape-thin-child-failure");
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          ALLOS_DB_PATH: path.join(dir, "allos.db"),
          UX_SHOTS: path.join(dir, "shots"),
          UX_SEED: "thin",
          UX_THIN_DAYS: "not-a-number",
          SEED_RNG: "",
          SEED_PERSONA: "",
          SEED_DIAL_SHAPE: "",
        },
      }
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("thinning scratch DB to the last ~7 days");
    expect(result.stderr).toContain(
      "post-seed transform exited non-zero for thin — aborting instead of censusing the full seed under the thin label"
    );
    expect(result.stdout).not.toContain("starting dev server");
  }, 30_000);
});
