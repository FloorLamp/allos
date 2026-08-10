// DB INTEGRATION TIER — the reported #2334 shape, end to end: a draw that carries all
// nine PhenoAge analytes but files glucose under the curated "Glucose, Fasting" entry
// (what a lab reporting a fasting panel imports as) and reports hs-CRP below its
// detection limit ("<0.2"). Before the fix this draw reached 8 of 9 inputs and no
// PhenoAge appeared anywhere, with nothing in the UI able to explain it — from the
// outside every analyte was plainly there.
//
// The glucose input now ACCEPTS the fasting sibling, preferring it (Levine's PhenoAge
// is defined on fasting serum glucose), while the two curated entries stay separate
// analytes everywhere else. The censored hs-CRP contributes its detection limit and
// the censoring marker travels to the result.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { getBioAgeReadings, getDerivedBiomarkerReadings } from "@/lib/queries";
import { setUserBirthdate } from "@/lib/settings";
import { db } from "@/lib/db";

// The canonical name since #2335 — aliased so the assertions stay readable.
const HOMA_IR = "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)";

const DATE = "2024-05-01";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertLab(
  profileId: number,
  canonical: string,
  unit: string,
  value: string,
  valueNum: number | null
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
  ).run(profileId, DATE, canonical, value, unit, canonical, valueNum);
}

// The seven PhenoAge inputs that are neither glucose nor hs-CRP, in canonical units.
// Ordinary adult numbers; the two interesting analytes are added per test.
function seedSevenInputs(profileId: number): void {
  insertLab(profileId, "Albumin", "g/dL", "4.4", 4.4);
  insertLab(profileId, "Creatinine", "mg/dL", "0.9", 0.9);
  insertLab(profileId, "Lymphocytes", "%", "32", 32);
  insertLab(profileId, "Mean Corpuscular Volume (MCV)", "fL", "89", 89);
  insertLab(profileId, "Red Cell Distribution Width (RDW)", "%", "13", 13);
  insertLab(profileId, "Alkaline Phosphatase", "U/L", "62", 62);
  insertLab(profileId, "White Blood Cell Count", "10^3/uL", "5.5", 5.5);
}

const CRP = "High-Sensitivity C-Reactive Protein (hs-CRP)";

describe("bio-age: a fasting-glucose draw with a censored hs-CRP", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("Fasting Glucose Draw");
    // Adult on the draw date so PhenoAge is produced (age gate).
    setUserBirthdate(profileId, "1980-01-01");
    seedSevenInputs(profileId);
  });

  it("produces a PhenoAge from the exact reported shape (fasting glucose + '<0.2' hs-CRP)", () => {
    insertLab(profileId, "Glucose, Fasting", "mg/dL", "90", 90);
    insertLab(profileId, CRP, "mg/L", "<0.2", null);

    const { draws, presentInputs } = getBioAgeReadings(profileId);
    // All nine inputs read as present — the glucose slot is satisfied by the
    // fasting entry, and the censored hs-CRP is a usable number.
    expect(presentInputs).toHaveLength(9);
    expect(presentInputs).toContain("Glucose, Fasting");
    expect(draws).toHaveLength(1);
    expect(draws[0].bioAge).toBeGreaterThan(0);

    // The draw names the entry the value came from and keeps the censoring marker.
    const glucose = draws[0].inputs.find((i) => i.name === "Glucose, Fasting");
    expect(glucose?.value).toBe(90);
    expect(glucose?.bound).toBeUndefined();
    const crp = draws[0].inputs.find((i) => i.name === CRP);
    expect(crp?.value).toBe(0.2);
    expect(crp?.bound).toBe("<");

    // …and the result says it rests on that censored input, with the direction of
    // the bias the substitution introduces.
    expect(draws[0].censored?.inputs).toEqual([
      { name: CRP, label: "CRP", bound: "<" },
    ]);
    expect(draws[0].censored?.bias).toBe("over");
  });

  it("emits the same PhenoAge row through the derived-table gather, marker intact", () => {
    insertLab(profileId, "Glucose, Fasting", "mg/dL", "90", 90);
    insertLab(profileId, CRP, "mg/L", "<0.2", null);

    const heroBioAge = getBioAgeReadings(profileId).draws[0].bioAge;
    const pheno = getDerivedBiomarkerReadings(profileId).filter(
      (r) => r.name === "PhenoAge"
    );
    expect(pheno).toHaveLength(1);
    expect(pheno[0].value_num).toBe(heroBioAge);
    // The substituted formula string every derived surface renders keeps the "<",
    // so the censored component is never printed as an exact reading.
    expect(pheno[0].derived_formula).toContain("CRP <0.2");
  });

  it("prefers the fasting value when the draw carries both glucose entries", () => {
    insertLab(profileId, "Glucose, Fasting", "mg/dL", "90", 90);
    insertLab(profileId, "Glucose", "mg/dL", "140", 140);
    insertLab(profileId, CRP, "mg/L", "0.4", 0.4);

    const { draws } = getBioAgeReadings(profileId);
    expect(draws).toHaveLength(1);
    expect(
      draws[0].inputs.find((i) => i.name === "Glucose, Fasting")?.value
    ).toBe(90);
    expect(draws[0].inputs.some((i) => i.name === "Glucose")).toBe(false);
  });

  it("still computes from an unqualified 'Glucose' draw (the older era of a history)", () => {
    insertLab(profileId, "Glucose", "mg/dL", "90", 90);
    insertLab(profileId, CRP, "mg/L", "0.4", 0.4);

    const { draws, presentInputs } = getBioAgeReadings(profileId);
    expect(presentInputs).toContain("Glucose, Fasting"); // the SLOT, satisfied
    expect(draws).toHaveLength(1);
    expect(draws[0].inputs.find((i) => i.name === "Glucose")?.value).toBe(90);
    // Nothing censored on this draw, so the result claims nothing about censoring.
    expect(draws[0].censored).toBeUndefined();
  });

  it("computes HOMA-IR from the same fasting draw (its input REQUIRES that frame)", () => {
    // Each index's acceptance list is its own claim, never a fold of the two curated
    // analytes. HOMA-IR requires the FASTING frame since #2357, so this draw — which
    // states it — produces one alongside PhenoAge.
    insertLab(profileId, "Glucose, Fasting", "mg/dL", "90", 90);
    insertLab(profileId, "Insulin", "uIU/mL", "6.1", 6.1);
    insertLab(profileId, CRP, "mg/L", "0.4", 0.4);

    const derived = getDerivedBiomarkerReadings(profileId);
    expect(derived.some((r) => r.name === HOMA_IR)).toBe(true);
    expect(derived.some((r) => r.name === "PhenoAge")).toBe(true);
  });

  it("declines HOMA-IR on an unqualified-glucose draw while PhenoAge still computes", () => {
    // The other side of #2357, end to end. The same draw satisfies PhenoAge (whose
    // glucose input accepts the unqualified entry as a fallback) and NOT HOMA-IR
    // (whose label asserts the fasting frame the reading does not state).
    insertLab(profileId, "Glucose", "mg/dL", "90", 90);
    insertLab(profileId, "Insulin", "uIU/mL", "6.1", 6.1);
    insertLab(profileId, CRP, "mg/L", "0.4", 0.4);

    const derived = getDerivedBiomarkerReadings(profileId);
    expect(derived.some((r) => r.name === HOMA_IR)).toBe(false);
    expect(derived.some((r) => r.name === "PhenoAge")).toBe(true);
  });

  it("declines when the draw carries no glucose at all", () => {
    insertLab(profileId, CRP, "mg/L", "0.4", 0.4);

    const { draws, presentInputs } = getBioAgeReadings(profileId);
    expect(presentInputs).not.toContain("Glucose, Fasting");
    expect(presentInputs).toHaveLength(8);
    expect(draws).toHaveLength(0);
  });
});
