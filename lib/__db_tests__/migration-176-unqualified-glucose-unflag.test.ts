// DB INTEGRATION TIER — migration 176 (#2337): retiring the flags allos derived for
// an unqualified `Glucose` against a fasting band it no longer publishes.
//
// Driven against a MINIMAL pre-migration schema (the migration-165/171/174 pattern),
// so every claim is about the migration and not about whatever else the baseline
// provides.
//
// The companion half of the change — that a NEW unqualified reading derives no flag
// while `Glucose, Fasting` still flags against 70–99 — is proven over the real
// canonical table in lib/__db_tests__/queries.test.ts.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/176-unqualified-glucose-unflag";

const DATE = "2017-03-09";

interface Row {
  canonical_name: string | null;
  flag: string | null;
  value_num: number | null;
}

function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT,
      name TEXT,
      canonical_name TEXT,
      value TEXT,
      value_num REAL,
      unit TEXT,
      reference_range TEXT,
      flag TEXT
    );
  `);
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'A'), (2, 'B')")
    .run();
  const rec = mem.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit,
        reference_range, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, 'mg/dL', ?, ?)`
  );
  // Profile 1 — every flavor the numeric reconcile could have left on an
  // unqualified glucose under the removed 65–99 / 70–85 bands.
  rec.run(1, DATE, "GLUCOSE", "Glucose", "130", 130, null, "high");
  rec.run(1, DATE, "GLUCOSE", "Glucose", "60", 60, null, "low");
  rec.run(1, DATE, "GLUCOSE", "Glucose", "92", 92, null, "non-optimal-high");
  rec.run(1, DATE, "GLUCOSE", "Glucose", "68", 68, null, "non-optimal-low");
  rec.run(1, DATE, "GLUCOSE", "Glucose", "80", 80, null, "normal");
  // …including one whose document DID print a range. The band that judged it was
  // still ours, so the flag goes; the printed range stays on the row and the detail
  // page renders it attributed (#2346).
  rec.run(1, DATE, "GLUCOSE", "Glucose", "130", 130, "65-99 mg/dL", "high");
  // A qualitative glucose row: value_num IS NULL, so the numeric reconcile never
  // judged it and its flag is not ours to clear.
  rec.run(1, DATE, "GLUCOSE", "Glucose", "Positive", null, null, "abnormal");
  // An unqualified glucose the numeric reconcile flagged 'abnormal'? It cannot —
  // 'abnormal' is the qualitative verdict and is never revisited. Guard it anyway.
  rec.run(1, DATE, "GLUCOSE", "Glucose", "130", 130, null, "abnormal");
  // The FASTING sibling keeps 70–99 and therefore keeps its flag.
  rec.run(
    1,
    DATE,
    "GLUCOSE, FASTING",
    "Glucose, Fasting",
    "130",
    130,
    null,
    "high"
  );
  // Neighbours that merely contain the word: untouched.
  rec.run(1, DATE, "GLUCOSE", "Glucose, Urine", "Negative", null, null, "high");
  rec.run(2, DATE, "HbA1c", "Hemoglobin A1c", "7.4", 7.4, null, "high");
  // A second profile's unqualified glucose — the pass is profile-agnostic.
  rec.run(2, DATE, "GLUCOSE", "Glucose", "150", 150, null, "high");
  return mem;
}

function rows(mem: Database.Database, profileId: number): Row[] {
  return mem
    .prepare(
      `SELECT canonical_name, flag, value_num FROM medical_records
        WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as Row[];
}

describe("migration 176 — unqualified glucose gives up its derived flags", () => {
  it("clears every numeric-reconcile flag on an unqualified Glucose, in every profile", () => {
    const mem = preMigrationDb();
    up(mem);

    const derived = rows(mem, 1).filter(
      (r) => r.canonical_name === "Glucose" && r.value_num != null
    );
    // Five band-derived flags plus the one with a printed range → all cleared;
    // the numeric 'abnormal' is a qualitative verdict and survives.
    expect(derived.map((r) => r.flag)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      "abnormal",
    ]);
    expect(
      rows(mem, 2).find((r) => r.canonical_name === "Glucose")?.flag
    ).toBeNull();
    mem.close();
  });

  it("keeps the row's own value and the range the document printed", () => {
    const mem = preMigrationDb();
    up(mem);
    const reported = mem
      .prepare(
        `SELECT value_num, reference_range, flag FROM medical_records
          WHERE profile_id = 1 AND reference_range IS NOT NULL`
      )
      .get() as { value_num: number; reference_range: string; flag: null };
    expect(reported.value_num).toBe(130);
    expect(reported.reference_range).toBe("65-99 mg/dL");
    expect(reported.flag).toBeNull();
    mem.close();
  });

  it("leaves the fasting sibling, a qualitative glucose, and every other analyte alone", () => {
    const mem = preMigrationDb();
    up(mem);
    const byName = (n: string, p = 1) =>
      rows(mem, p).filter((r) => r.canonical_name === n);
    expect(byName("Glucose, Fasting").map((r) => r.flag)).toEqual(["high"]);
    expect(byName("Glucose, Urine").map((r) => r.flag)).toEqual(["high"]);
    expect(byName("Hemoglobin A1c", 2).map((r) => r.flag)).toEqual(["high"]);
    // The qualitative unqualified glucose (value_num IS NULL).
    expect(
      rows(mem, 1).filter(
        (r) => r.canonical_name === "Glucose" && r.value_num == null
      )[0].flag
    ).toBe("abnormal");
    mem.close();
  });

  it("is a no-op on replay (idempotent)", () => {
    const mem = preMigrationDb();
    up(mem);
    const after = rows(mem, 1);
    up(mem);
    expect(rows(mem, 1)).toEqual(after);
    mem.close();
  });
});
