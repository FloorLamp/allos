// DB INTEGRATION TIER — the two urine ratios end to end (#2300). The arithmetic is
// covered purely in lib/__tests__/derived-biomarkers.test.ts; what only this tier can
// show is the part the pure test cannot fake: that the SPECIMEN survives the real read
// path. The query layer loads one series per input canonical name through the
// profile-scoped biomarker query, so a draw carrying BOTH a serum "Creatinine" and a
// "Creatinine, Urine" must feed the ratio the urine one — in mg/dL the two differ by
// ~100×, and picking serum turns a normal 30 mg/g ACR into 3000 mg/g, which is deep
// inside albuminuria staging.
//
// Every value here is an invented round number, not a reading from any corpus.
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
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'Urinalysis')`
  ).run(profileId, date, canonical, String(value), unit, canonical, value);
}

function rowFor(profileId: number, name: string, date: string) {
  return getDerivedBiomarkerReadings(profileId).find(
    (r) => r.name === name && r.date === date
  );
}

describe("derived urine ratios", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("Urine Ratio Test");
  });

  it("computes the ACR from the URINE creatinine while a serum one sits on the same draw", () => {
    insertLab(profileId, "Albumin, Urine", 30, "mg/L");
    insertLab(profileId, "Creatinine, Urine", 100, "mg/dL");
    insertLab(profileId, "Creatinine", 1, "mg/dL");

    const acr = rowFor(profileId, "Microalbumin/Creatinine Ratio, Urine", DRAW);
    expect(acr?.value_num).toBe(30);
    expect(acr?.unit).toBe("mg/g");
    expect(acr?.derived).toBe(true);
    // The serum creatinine would have given 3000 — the 100× error this guards.
    expect(acr?.derived_formula).toContain("urine creatinine");
  });

  it("emits NO ratio for a draw that carries only the serum creatinine", () => {
    insertLab(profileId, "Albumin, Urine", 30, "mg/L", LATER);
    insertLab(profileId, "Creatinine", 1, "mg/dL", LATER);

    expect(
      rowFor(profileId, "Microalbumin/Creatinine Ratio, Urine", LATER)
    ).toBeUndefined();
  });

  it("computes the protein/creatinine ratio, converting the protein unit first", () => {
    // `Protein, Urine` is curated UNITLESS (the dipstick pad), so the spec declares
    // mg/dL; a mg/L row must be rescaled rather than divided as-is.
    insertLab(profileId, "Protein, Urine", 150, "mg/L");
    insertLab(profileId, "Creatinine, Urine", 100, "mg/dL");

    expect(
      rowFor(profileId, "Protein/Creatinine Ratio, Urine", DRAW)?.value_num
    ).toBe(150);
  });

  it("leaves a lab-reported ratio's own draw alone", () => {
    insertLab(profileId, "Albumin, Urine", 30, "mg/L");
    insertLab(profileId, "Creatinine, Urine", 100, "mg/dL");
    insertLab(profileId, "Microalbumin/Creatinine Ratio, Urine", 28, "mg/g");
    // A later draw the lab did NOT print the ratio on still gets a computed one.
    insertLab(profileId, "Albumin, Urine", 20, "mg/L", LATER);
    insertLab(profileId, "Creatinine, Urine", 100, "mg/dL", LATER);

    expect(
      rowFor(profileId, "Microalbumin/Creatinine Ratio, Urine", DRAW)
    ).toBeUndefined();
    expect(
      rowFor(profileId, "Microalbumin/Creatinine Ratio, Urine", LATER)
        ?.value_num
    ).toBe(20);
  });

  it("ignores a purely qualitative dipstick protein (nothing numeric to divide)", () => {
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
       VALUES (?, ?, 'lab', 'Protein, Urine', 'Negative', NULL, 'Protein, Urine', NULL, 'Urinalysis')`
    ).run(profileId, DRAW);
    insertLab(profileId, "Creatinine, Urine", 100, "mg/dL");

    expect(
      rowFor(profileId, "Protein/Creatinine Ratio, Urine", DRAW)
    ).toBeUndefined();
  });
});
