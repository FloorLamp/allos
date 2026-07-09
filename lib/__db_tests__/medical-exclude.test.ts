// DB INTEGRATION TIER — getMedicalRecords excludeCategories filter.
//
// The Biomarkers browser hides medications (category='prescription') via a new
// `excludeCategories` filter on getMedicalRecords (a parameterized category NOT IN
// (…)). These tests seed a real (throwaway) SQLite DB with a mix of categories and
// prove the clause drops exactly the excluded rows, no-ops on an empty list, and
// stays profile-scoped.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getMedicalRecords } from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";

let fx: SeededProfile;

beforeAll(() => {
  fx = seedProfile("EXCL");
  // The fixture seeds one 'lab' Glucose row. Add a 'prescription' (medication) row
  // and a 'vitals' row, so the exclude filter has something to drop and something
  // to keep.
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, canonical_name)
     VALUES (?, ?, 'prescription', 'Lisinopril 10mg', 'Lisinopril')`
  ).run(fx.profileId, fx.todayStr);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit)
     VALUES (?, ?, 'vitals', 'Blood Pressure', 'Blood Pressure', '120/80', 120, 'mmHg')`
  ).run(fx.profileId, fx.todayStr);
});

describe("getMedicalRecords excludeCategories", () => {
  it("drops the excluded category and keeps the rest", () => {
    // Baseline: all three categories present.
    const all = getMedicalRecords(fx.profileId);
    expect(all.map((r) => r.category).sort()).toEqual([
      "lab",
      "prescription",
      "vitals",
    ]);

    const noRx = getMedicalRecords(fx.profileId, {
      excludeCategories: ["prescription"],
    });
    const cats = noRx.map((r) => r.category);
    expect(cats).not.toContain("prescription");
    expect(cats.sort()).toEqual(["lab", "vitals"]);
    // The medication row itself is gone.
    expect(noRx.some((r) => r.name === "Lisinopril 10mg")).toBe(false);
  });

  it("an empty exclude list is a no-op (all rows returned)", () => {
    expect(
      getMedicalRecords(fx.profileId, { excludeCategories: [] })
    ).toHaveLength(3);
  });

  it("stays profile-scoped — the clause never widens to another profile", () => {
    const other = seedProfile("EXCL2"); // only its own seeded 'lab' Glucose row
    const rows = getMedicalRecords(other.profileId, {
      excludeCategories: ["prescription"],
    });
    expect(rows).toHaveLength(1);
    expect(
      rows.every(
        (r) =>
          (r as unknown as { profile_id: number }).profile_id ===
          other.profileId
      )
    ).toBe(true);
    // fx's medication row never leaks across the profile boundary.
    expect(rows.some((r) => r.name === "Lisinopril 10mg")).toBe(false);
  });
});
