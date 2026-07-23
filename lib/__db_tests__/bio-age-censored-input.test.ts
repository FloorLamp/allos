// DB INTEGRATION TIER — a below-detection PhenoAge input must not silently drop the
// whole biological-age draw. The reported case: hs-CRP reported as "<0.2 mg/L" (a
// left-censored, below-detection reading) has no exact value_num, so the old gather
// filter (`value_num != null`) dropped it — the input showed as "missing" and no
// PhenoAge value computed even though the other eight analytes were present on the
// same draw. getBioAgeReadings now recovers the DETECTION LIMIT of a bounded reading
// (componentNumeric → plottableReadingValue), so an undetectable hs-CRP (the good,
// low-inflammation case) contributes its limit and the draw completes.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { getBioAgeReadings, getDerivedBiomarkerReadings } from "@/lib/queries";
import { setUserBirthdate } from "@/lib/settings";
import { db } from "@/lib/db";

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

// The eight non-CRP PhenoAge inputs, in their canonical units, as clean numbers on
// the single draw date. hs-CRP is added per-test so its value form can vary.
function seedEightInputs(profileId: number): void {
  insertLab(profileId, "Albumin", "g/dL", "4.4", 4.4);
  insertLab(profileId, "Creatinine", "mg/dL", "0.9", 0.9);
  insertLab(profileId, "Glucose", "mg/dL", "90", 90);
  insertLab(profileId, "Lymphocytes", "%", "32", 32);
  insertLab(profileId, "Mean Corpuscular Volume (MCV)", "fL", "89", 89);
  insertLab(profileId, "Red Cell Distribution Width (RDW)", "%", "13", 13);
  insertLab(profileId, "Alkaline Phosphatase", "U/L", "62", 62);
  insertLab(profileId, "White Blood Cell Count", "10^3/uL", "5.5", 5.5);
}

describe("bio-age: below-detection hs-CRP still completes the PhenoAge draw", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("Censored CRP Test");
    // Adult on the draw date so PhenoAge is produced (age gate).
    setUserBirthdate(profileId, "1980-01-01");
    seedEightInputs(profileId);
  });

  it("recovers the detection limit from a '<0.2 mg/L' hs-CRP and completes the draw", () => {
    // Bounded / below-detection reading: no exact value_num, only the "<0.2" string.
    insertLab(
      profileId,
      "High-Sensitivity C-Reactive Protein (hs-CRP)",
      "mg/L",
      "<0.2",
      null
    );

    const { draws, presentInputs } = getBioAgeReadings(profileId);
    expect(presentInputs).toContain(
      "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
    expect(draws).toHaveLength(1);
    // The draw's CRP input carries the detection limit (0.2 mg/L), not a dropped value.
    const crp = draws[0].inputs.find(
      (i) => i.name === "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
    expect(crp?.value).toBe(0.2);
    expect(draws[0].bioAge).toBeGreaterThan(0);
  });

  it("computes the same PhenoAge as an exact 0.2 mg/L hs-CRP would", () => {
    insertLab(
      profileId,
      "High-Sensitivity C-Reactive Protein (hs-CRP)",
      "mg/L",
      "<0.2",
      null
    );
    const bounded = getBioAgeReadings(profileId).draws[0].bioAge;

    const other = newProfile("Exact CRP Test");
    setUserBirthdate(other, "1980-01-01");
    seedEightInputs(other);
    insertLab(
      other,
      "High-Sensitivity C-Reactive Protein (hs-CRP)",
      "mg/L",
      "0.2",
      0.2
    );
    const exact = getBioAgeReadings(other).draws[0].bioAge;

    expect(bounded).toBe(exact);
  });

  it("emits the same PhenoAge row through the derived-table gather (hero ↔ table parity)", () => {
    insertLab(
      profileId,
      "High-Sensitivity C-Reactive Protein (hs-CRP)",
      "mg/L",
      "<0.2",
      null
    );

    // The derived-biomarker gather (the biomarkers-table path) recovers the same
    // censored input, so the PhenoAge row it emits matches the hero's draw — the
    // two surfaces don't disagree about whether the draw is complete.
    const heroBioAge = getBioAgeReadings(profileId).draws[0].bioAge;
    const phenoRows = getDerivedBiomarkerReadings(profileId).filter(
      (r) => r.name === "PhenoAge"
    );
    expect(phenoRows).toHaveLength(1);
    expect(phenoRows[0].value_num).toBe(heroBioAge);
  });

  it("still drops a purely qualitative hs-CRP (nothing numeric to use)", () => {
    insertLab(
      profileId,
      "High-Sensitivity C-Reactive Protein (hs-CRP)",
      "mg/L",
      "see note",
      null
    );

    const { draws, presentInputs } = getBioAgeReadings(profileId);
    expect(presentInputs).not.toContain(
      "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
    expect(draws).toHaveLength(0);
  });
});
