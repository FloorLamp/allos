// DB INTEGRATION TIER — the lipid RATIOS end to end (#1582). The arithmetic is
// covered purely in lib/__tests__/derived-biomarkers.test.ts; what only the DB tier
// can show is the rest of the pipeline: the stored components are read through the
// profile-scoped series query, each computed ratio is flagged against its canonical
// row by the same reconciledFlag a stored reading gets, and a draw the LAB itself
// reported the ratio on is left alone rather than shadowed by a computed duplicate.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { getDerivedBiomarkerReadings } from "@/lib/queries";
import { db } from "@/lib/db";

const DRAW = "2024-05-01";
const LATER = "2024-11-01";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertLab(
  profileId: number,
  canonical: string,
  value: number,
  unit: string | null,
  date = DRAW
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'Lipids')`
  ).run(profileId, date, canonical, String(value), unit, canonical, value);
}

function rowFor(profileId: number, name: string, date: string) {
  return getDerivedBiomarkerReadings(profileId).find(
    (r) => r.name === name && r.date === date
  );
}

describe("derived lipid ratios", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("Lipid Ratio Test");
    // A coherent dyslipidemia draw: total 244, LDL 168, HDL 54.
    insertLab(profileId, "Total Cholesterol", 244, "mg/dL");
    insertLab(profileId, "LDL Cholesterol", 168, "mg/dL");
    insertLab(profileId, "HDL Cholesterol", 54, "mg/dL");
  });

  it("computes both ratios from one draw and flags them against their canonical bands", () => {
    const chol = rowFor(profileId, "Cholesterol/HDL Ratio", DRAW);
    expect(chol?.value_num).toBeCloseTo(4.52, 2);
    expect(chol?.derived).toBe(true);
    // 4.52 sits under the 5 reference ceiling but over the 3.5 optimal one.
    expect(chol?.flag).toBe("non-optimal-high");
    expect(chol?.derived_formula).toContain("Total Cholesterol ÷ HDL");

    const ldl = rowFor(profileId, "LDL/HDL Ratio", DRAW);
    expect(ldl?.value_num).toBeCloseTo(3.11, 2);
    // 3.11 is inside the 3.5 reference ceiling, and the entry carries no optimal
    // band, so the computed reading takes no flag at all.
    expect(ldl?.flag).toBeNull();
  });

  it("leaves a lab-reported ratio's own draw alone", () => {
    // The premise of the issue: some vendors print the ratio. On a draw that has a
    // STORED reading, the computed duplicate must not appear beside it — but the
    // draw the vendor omitted still gets one.
    insertLab(profileId, "LDL/HDL Ratio", 3.4, null);
    insertLab(profileId, "Total Cholesterol", 210, "mg/dL", LATER);
    insertLab(profileId, "LDL Cholesterol", 130, "mg/dL", LATER);
    insertLab(profileId, "HDL Cholesterol", 60, "mg/dL", LATER);

    expect(rowFor(profileId, "LDL/HDL Ratio", DRAW)).toBeUndefined();
    expect(rowFor(profileId, "LDL/HDL Ratio", LATER)?.value_num).toBeCloseTo(
      2.17,
      2
    );
    // The other ratio is a separate identity, so the stored one does not suppress
    // it on the same draw (#482 — they are not one family).
    expect(rowFor(profileId, "Cholesterol/HDL Ratio", DRAW)).toBeDefined();
  });

  it("declines a ratio whose component unit cannot be put on the mg/dL scale", () => {
    const other = newProfile("Unconvertible Unit");
    insertLab(other, "Total Cholesterol", 244, "mg/dL");
    insertLab(other, "LDL Cholesterol", 168, "mg/dL");
    insertLab(other, "HDL Cholesterol", 54, "%");

    expect(rowFor(other, "Cholesterol/HDL Ratio", DRAW)).toBeUndefined();
    expect(rowFor(other, "LDL/HDL Ratio", DRAW)).toBeUndefined();
  });
});
