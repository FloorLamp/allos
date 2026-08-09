import { describe, it, expect } from "vitest";
import {
  computeDerivedReadings,
  ckdEpi2021,
  phenoAge,
  derivedInputCanonicalNames,
  derivedInputCanonicalNamesFor,
  derivedInputKeysFor,
  derivedInputSlots,
  derivedInputUnitsFor,
  DERIVED_NAMES,
  DERIVED_DEFS_BY_NAME,
  AGE_INPUT_KEY,
  PHENOAGE_MIN_AGE,
  type ComponentReading,
  type DerivedDemographics,
  type PhenoAgeReferenceResolver,
} from "../derived-biomarkers";
import { canonicalBiomarkerForName } from "../datasets/canonical-biomarkers";
import { reconciledFlag } from "../reference-range";
import {
  biomarkerFamily,
  buildCanonicalIndex,
  normalizeCanonicalKey,
} from "../canonical-name";
import { panelForCanonicalName } from "../biomarker-panels";
import canonicalSeed from "../canonical-biomarkers.json";

// The two derived indices whose canonical names are long "Full Name (ABBR)" forms
// since #2335 — aliased here so the assertions below stay readable.
const HOMA_IR = "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)";
const EGFR = "Estimated Glomerular Filtration Rate (eGFR)";

// A demographics resolver with a fixed age + sex (eGFR needs both).
function demo(
  sex: DerivedDemographics["sex"],
  age: number | null
): DerivedDemographics {
  return { sex, ageOn: () => age };
}

const noDemo = demo(null, null);

function seriesOf(
  entries: Record<string, ComponentReading[]>
): Map<string, ComponentReading[]> {
  return new Map(Object.entries(entries));
}

function find(
  readings: ReturnType<typeof computeDerivedReadings>,
  name: string,
  date: string
) {
  return readings.find((r) => r.name === name && r.date === date);
}

describe("computeDerivedReadings — Non-HDL Cholesterol", () => {
  it("computes Total − HDL in mg/dL", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205, unit: "mg/dL" },
        ],
        "HDL Cholesterol": [{ date: "2024-01-01", value: 47, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Non-HDL Cholesterol", "2024-01-01")?.value).toBe(158);
  });

  it("gives the SAME answer from mmol/L inputs (converted first)", () => {
    // 205 mg/dL = 5.301 mmol/L; 47 mg/dL = 1.2154 mmol/L. Computing the difference
    // in mmol/L then reading it as mg/dL would be wrong; conversion first fixes it.
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205 / 38.67, unit: "mmol/L" },
        ],
        "HDL Cholesterol": [
          { date: "2024-01-01", value: 47 / 38.67, unit: "mmol/L" },
        ],
      }),
      noDemo
    );
    expect(find(r, "Non-HDL Cholesterol", "2024-01-01")?.value).toBe(158);
  });
});

// The two cholesterol ratios (#1582). Some labs print them and some don't, so the
// registry computes them from the components every lipid panel carries. Both share
// the HDL denominator, so they are exercised together — including the fact that they
// stay SEPARATE identities (#482) rather than collapsing into one "the ratio" row.
describe("computeDerivedReadings — the cholesterol ratios", () => {
  const draw = (
    entries: Record<string, [number, string | null]>
  ): Map<string, ComponentReading[]> =>
    seriesOf(
      Object.fromEntries(
        Object.entries(entries).map(([name, [value, unit]]) => [
          name,
          [{ date: "2024-01-01", value, unit }],
        ])
      )
    );

  const MGDL = draw({
    "Total Cholesterol": [205, "mg/dL"],
    "LDL Cholesterol": [128, "mg/dL"],
    "HDL Cholesterol": [47, "mg/dL"],
  });

  it("computes Total ÷ HDL and LDL ÷ HDL from a mg/dL draw", () => {
    const r = computeDerivedReadings(MGDL, noDemo);
    expect(find(r, "Cholesterol/HDL Ratio", "2024-01-01")?.value).toBeCloseTo(
      4.36,
      2
    );
    expect(find(r, "LDL/HDL Ratio", "2024-01-01")?.value).toBeCloseTo(2.72, 2);
  });

  it("keeps the two ratios as separate identities on one draw (#482)", () => {
    // Different numerators, different reference bands: one being in range must never
    // stand in for the other, so they are two rows, never one collapsed "ratio".
    const r = computeDerivedReadings(MGDL, noDemo);
    const chol = find(r, "Cholesterol/HDL Ratio", "2024-01-01");
    const ldl = find(r, "LDL/HDL Ratio", "2024-01-01");
    expect(chol).toBeDefined();
    expect(ldl).toBeDefined();
    expect(chol?.value).not.toBe(ldl?.value);
    expect(biomarkerFamily("Cholesterol/HDL Ratio")).not.toBe(
      biomarkerFamily("LDL/HDL Ratio")
    );
  });

  it("labels each computed reading with its canonical entry's unit", () => {
    const r = computeDerivedReadings(MGDL, noDemo);
    // Cholesterol/HDL's canonical row is "ratio"; LDL/HDL's records the ratio as
    // unitless, so the computed reading carries no unit either.
    expect(find(r, "Cholesterol/HDL Ratio", "2024-01-01")?.unit).toBe("ratio");
    expect(find(r, "LDL/HDL Ratio", "2024-01-01")?.unit).toBeNull();
  });

  it("gives the same ratios from mmol/L inputs (converted to mg/dL first)", () => {
    // Both numerator and denominator are cholesterol species, so this ratio happens
    // to be scale-invariant — but the values are still converted to ONE unit system
    // before dividing, which is what makes that true rather than lucky.
    const r = computeDerivedReadings(
      draw({
        "Total Cholesterol": [205 / 38.67, "mmol/L"],
        "LDL Cholesterol": [128 / 38.67, "mmol/L"],
        "HDL Cholesterol": [47 / 38.67, "mmol/L"],
      }),
      noDemo
    );
    expect(find(r, "Cholesterol/HDL Ratio", "2024-01-01")?.value).toBeCloseTo(
      4.36,
      2
    );
    expect(find(r, "LDL/HDL Ratio", "2024-01-01")?.value).toBeCloseTo(2.72, 2);
  });

  it("declines when a component's unit cannot be converted to mg/dL", () => {
    // A "%" HDL is not a concentration this file can put on the mg/dL scale, so the
    // reading drops out of the pairing and NEITHER ratio is invented from it.
    const r = computeDerivedReadings(
      draw({
        "Total Cholesterol": [205, "mg/dL"],
        "LDL Cholesterol": [128, "mg/dL"],
        "HDL Cholesterol": [47, "%"],
      }),
      noDemo
    );
    expect(find(r, "Cholesterol/HDL Ratio", "2024-01-01")).toBeUndefined();
    expect(find(r, "LDL/HDL Ratio", "2024-01-01")).toBeUndefined();
  });

  it("declines each ratio whose own numerator is missing", () => {
    // LDL absent: the LDL ratio is simply not produced. It is NOT back-filled from
    // Total − HDL − VLDL — a lab-calculated LDL is one inference already, and this
    // file never stacks a second one on top of it.
    const r = computeDerivedReadings(
      draw({
        "Total Cholesterol": [205, "mg/dL"],
        "HDL Cholesterol": [47, "mg/dL"],
      }),
      noDemo
    );
    expect(find(r, "Cholesterol/HDL Ratio", "2024-01-01")?.value).toBeCloseTo(
      4.36,
      2
    );
    expect(find(r, "LDL/HDL Ratio", "2024-01-01")).toBeUndefined();

    // HDL absent: the shared denominator is gone, so both decline.
    const noHdl = computeDerivedReadings(
      draw({
        "Total Cholesterol": [205, "mg/dL"],
        "LDL Cholesterol": [128, "mg/dL"],
      }),
      noDemo
    );
    expect(find(noHdl, "Cholesterol/HDL Ratio", "2024-01-01")).toBeUndefined();
    expect(find(noHdl, "LDL/HDL Ratio", "2024-01-01")).toBeUndefined();
  });

  it("declines a non-positive HDL (divide-by-zero guard)", () => {
    const r = computeDerivedReadings(
      draw({
        "Total Cholesterol": [205, "mg/dL"],
        "LDL Cholesterol": [128, "mg/dL"],
        "HDL Cholesterol": [0, "mg/dL"],
      }),
      noDemo
    );
    expect(find(r, "Cholesterol/HDL Ratio", "2024-01-01")).toBeUndefined();
    expect(find(r, "LDL/HDL Ratio", "2024-01-01")).toBeUndefined();
  });

  // The dataset row as the flag machinery wants it: the curated entries carry no
  // sex-specific optimal bands, which reconciledFlag's shape lists explicitly.
  const rangesFor = (name: string) => {
    const cb = canonicalBiomarkerForName(name);
    if (!cb) throw new Error(`no canonical entry for ${name}`);
    return {
      ...cb,
      optimal_low_male: null,
      optimal_high_male: null,
      optimal_low_female: null,
      optimal_high_female: null,
    };
  };

  it("flags a computed ratio against its canonical band, at the boundary", () => {
    // The derived value goes through the SAME reconciledFlag as a stored reading, so
    // the bands are the canonical entries' — Cholesterol/HDL: optimal ≤3.5, reference
    // ≤5; LDL/HDL: reference ≤3.5, no optimal band.
    const chol = rangesFor("Cholesterol/HDL Ratio");
    expect(reconciledFlag(null, 3.5, "ratio", chol)).toBeUndefined();
    expect(reconciledFlag(null, 3.51, "ratio", chol)).toBe("non-optimal-high");
    expect(reconciledFlag(null, 5, "ratio", chol)).toBe("non-optimal-high");
    expect(reconciledFlag(null, 5.01, "ratio", chol)).toBe("high");

    const ldl = rangesFor("LDL/HDL Ratio");
    expect(reconciledFlag(null, 3.5, null, ldl)).toBeUndefined();
    expect(reconciledFlag(null, 3.51, null, ldl)).toBe("high");
  });
});

describe("computeDerivedReadings — Triglyceride/HDL Ratio", () => {
  it("computes TG ÷ HDL in mg/dL", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Triglycerides: [{ date: "2024-01-01", value: 145, unit: "mg/dL" }],
        "HDL Cholesterol": [{ date: "2024-01-01", value: 47, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Triglyceride/HDL Ratio", "2024-01-01")?.value).toBeCloseTo(
      3.09,
      2
    );
  });

  it("mmol/L inputs give the mg/dL ratio, NOT the (wrong) mmol/L ratio", () => {
    // Direct mmol/L ratio would be ~1.35 (TG 1.637 / HDL 1.215) — wrong, because TG
    // and HDL have different molar masses. Converting both to mg/dL first yields the
    // correct 3.09.
    const r = computeDerivedReadings(
      seriesOf({
        Triglycerides: [
          { date: "2024-01-01", value: 145 / 88.57, unit: "mmol/L" },
        ],
        "HDL Cholesterol": [
          { date: "2024-01-01", value: 47 / 38.67, unit: "mmol/L" },
        ],
      }),
      noDemo
    );
    const v = find(r, "Triglyceride/HDL Ratio", "2024-01-01")?.value;
    expect(v).toBeCloseTo(3.09, 2);
    expect(v).not.toBeCloseTo(1.35, 1);
  });

  it("declines a non-positive HDL (divide-by-zero guard)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Triglycerides: [{ date: "2024-01-01", value: 145, unit: "mg/dL" }],
        "HDL Cholesterol": [{ date: "2024-01-01", value: 0, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Triglyceride/HDL Ratio", "2024-01-01")).toBeUndefined();
  });
});

// HOMA-IR's glucose input REQUIRES the fasting frame (#2357) — the index is defined
// on a fasting measurement and its own label says so, so the unqualified "Glucose"
// entry (which since #2337 is explicitly the unknown-frame one) is not accepted.
describe("computeDerivedReadings — HOMA-IR", () => {
  it("computes (fasting glucose mg/dL × insulin µU/mL) ÷ 405", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Glucose, Fasting": [{ date: "2024-01-01", value: 96, unit: "mg/dL" }],
        Insulin: [{ date: "2024-01-01", value: 9.5, unit: "uIU/mL" }],
      }),
      noDemo
    );
    // (96 × 9.5) / 405 = 2.2519
    expect(find(r, HOMA_IR, "2024-01-01")?.value).toBeCloseTo(2.25, 2);
    // The reading names the entry the value came from.
    expect(find(r, HOMA_IR, "2024-01-01")?.inputs.map((i) => i.name)).toEqual([
      "Glucose, Fasting",
      "Insulin",
    ]);
  });

  it("matches from mmol/L glucose + pmol/L insulin (converted first)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Glucose, Fasting": [
          { date: "2024-01-01", value: 96 / 18.02, unit: "mmol/L" },
        ],
        Insulin: [{ date: "2024-01-01", value: 9.5 / 0.1439, unit: "pmol/L" }],
      }),
      noDemo
    );
    expect(find(r, HOMA_IR, "2024-01-01")?.value).toBeCloseTo(2.25, 1);
  });

  it("produces NOTHING from an unqualified glucose, even with insulin on the draw", () => {
    // The behaviour change of #2357, asserted as an ABSENCE: the draw is otherwise
    // complete, and the index declines rather than computing on a frame the reading
    // does not state. Not a zero, not a guess — no HOMA-IR at all.
    const r = computeDerivedReadings(
      seriesOf({
        Glucose: [{ date: "2024-01-01", value: 96, unit: "mg/dL" }],
        Insulin: [{ date: "2024-01-01", value: 9.5, unit: "uIU/mL" }],
      }),
      noDemo
    );
    expect(find(r, HOMA_IR, "2024-01-01")).toBeUndefined();
    expect(r.some((x) => x.name === HOMA_IR)).toBe(false);
  });

  it("ignores an unqualified glucose sitting beside the fasting one", () => {
    // Both entries on one draw: the fasting value is the only one this index accepts,
    // so the answer is the fasting answer and the other reading is not a fallback.
    const r = computeDerivedReadings(
      seriesOf({
        "Glucose, Fasting": [{ date: "2024-01-01", value: 96, unit: "mg/dL" }],
        Glucose: [{ date: "2024-01-01", value: 150, unit: "mg/dL" }],
        Insulin: [{ date: "2024-01-01", value: 9.5, unit: "uIU/mL" }],
      }),
      noDemo
    );
    expect(find(r, HOMA_IR, "2024-01-01")?.value).toBeCloseTo(2.25, 2);
  });
});

describe("computeDerivedReadings — eGFR (CKD-EPI 2021)", () => {
  it("ckdEpi2021 matches published coefficients", () => {
    // Male, Scr 0.9, age 40: ratio = 1, 0.9938^40 ≈ 0.7797, ×142 ≈ 110.7.
    expect(ckdEpi2021(0.9, 40, "male")).toBeCloseTo(110.74, 1);
    // Female, Scr 0.9, age 40: applies κ=0.7, α=-0.241, ×1.012 ≈ 82.9.
    expect(ckdEpi2021(0.9, 40, "female")).toBeCloseTo(82.9, 1);
  });

  it("computes eGFR from creatinine when age+sex are known", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo("male", 40)
    );
    expect(find(r, EGFR, "2024-01-01")?.value).toBe(111);
  });

  it("converts umol/L creatinine before applying the equation", () => {
    // 0.9 mg/dL = ~79.6 umol/L → same eGFR.
    const r = computeDerivedReadings(
      seriesOf({
        Creatinine: [
          { date: "2024-01-01", value: 0.9 / 0.0113, unit: "umol/L" },
        ],
      }),
      demo("male", 40)
    );
    expect(find(r, EGFR, "2024-01-01")?.value).toBe(111);
  });

  it("declines eGFR when sex is unknown (never guesses)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo(null, 40)
    );
    expect(find(r, EGFR, "2024-01-01")).toBeUndefined();
  });

  it("declines eGFR when age is unknown (never guesses)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo("male", null)
    );
    expect(find(r, EGFR, "2024-01-01")).toBeUndefined();
  });

  it("declines eGFR below the adult floor — CKD-EPI is adult-only (#490)", () => {
    // A 10-year-old with a creatinine + known sex used to get an adult-formula
    // eGFR; the pediatric floor (matching PhenoAge) now returns nothing instead of
    // a clinically invalid number (bedside-Schwartz, not CKD-EPI, applies for kids).
    const child = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo("male", 10)
    );
    expect(find(child, EGFR, "2024-01-01")).toBeUndefined();
    // Still produced for an adult at exactly the floor.
    const adult = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo("male", 18)
    );
    expect(find(adult, EGFR, "2024-01-01")?.value).toBeGreaterThan(0);
  });
});

describe("phenoAge — Levine 2018 formula (worked example)", () => {
  // Independently computed from the published two-step formula (see
  // scripts scratch / paper): a healthy 45-year-old with the canonical draw
  //   Albumin 47 g/L, Creatinine 88.4017 µmol/L, Glucose 4.9950 mmol/L,
  //   hs-CRP 0.05 mg/dL, Lymphocytes 35 %, MCV 90 fL, RDW 13 %, ALP 65 U/L,
  //   WBC 5.5 (10^9/L), age 45  →  PhenoAge ≈ 35.75 years.
  it("matches a hand-computed worked example (formula units)", () => {
    const v = phenoAge({
      albuminGL: 47,
      creatinineUmolL: 88.4017,
      glucoseMmolL: 90 / 18.0182,
      crpMgDl: 0.05,
      lymphocytePct: 35,
      mcvFl: 90,
      rdwPct: 13,
      alpUL: 65,
      wbcThousandUl: 5.5,
      ageYears: 45,
    });
    expect(v).toBeCloseTo(35.75, 1);
  });

  it("gives an older biological age for a less healthy 60-year-old", () => {
    const v = phenoAge({
      albuminGL: 42,
      creatinineUmolL: 1.1 * 88.4017,
      glucoseMmolL: 105 / 18.0182,
      crpMgDl: 0.2,
      lymphocytePct: 24,
      mcvFl: 92,
      rdwPct: 14.5,
      alpUL: 95,
      wbcThousandUl: 7.0,
      ageYears: 60,
    });
    expect(v).toBeCloseTo(64.29, 1);
  });

  it("declines (null) when hs-CRP is non-positive (ln undefined)", () => {
    expect(
      phenoAge({
        albuminGL: 47,
        creatinineUmolL: 88.4,
        glucoseMmolL: 5,
        crpMgDl: 0,
        lymphocytePct: 35,
        mcvFl: 90,
        rdwPct: 13,
        alpUL: 65,
        wbcThousandUl: 5.5,
        ageYears: 45,
      })
    ).toBeNull();
  });
});

describe("computeDerivedReadings — PhenoAge", () => {
  // A full nine-analyte draw in the app's CANONICAL units (Albumin g/dL,
  // Creatinine mg/dL, Glucose mg/dL, hs-CRP mg/L, Lymphocytes %, MCV fL, RDW %,
  // ALP U/L, WBC 10^3/uL) on one date. Same subject as the worked example.
  function fullDraw(
    date: string,
    over: Partial<Record<string, ComponentReading[]>> = {}
  ): Record<string, ComponentReading[]> {
    return {
      Albumin: [{ date, value: 4.7, unit: "g/dL" }],
      Creatinine: [{ date, value: 1.0, unit: "mg/dL" }],
      Glucose: [{ date, value: 90, unit: "mg/dL" }],
      "High-Sensitivity C-Reactive Protein (hs-CRP)": [
        { date, value: 0.5, unit: "mg/L" },
      ],
      "Lymphocytes, Relative": [{ date, value: 35, unit: "%" }],
      "Mean Corpuscular Volume (MCV)": [{ date, value: 90, unit: "fL" }],
      "Red Cell Distribution Width (RDW)": [{ date, value: 13, unit: "%" }],
      "Alkaline Phosphatase": [{ date, value: 65, unit: "U/L" }],
      "White Blood Cell Count": [{ date, value: 5.5, unit: "10^3/uL" }],
      ...over,
    };
  }

  it("computes PhenoAge from a complete canonical-unit draw for an adult", () => {
    const r = computeDerivedReadings(
      seriesOf(fullDraw("2024-01-01")),
      demo("male", 45)
    );
    expect(find(r, "PhenoAge", "2024-01-01")?.value).toBeCloseTo(35.7, 1);
  });

  it("gives the same answer from alternate reporting units (converted first)", () => {
    // Albumin g/L, Creatinine µmol/L, Glucose mmol/L, hs-CRP mg/dL — each converts
    // to the canonical unit before the formula's own unit conversion runs.
    const r = computeDerivedReadings(
      seriesOf(
        fullDraw("2024-01-01", {
          Albumin: [{ date: "2024-01-01", value: 47, unit: "g/L" }],
          Creatinine: [
            { date: "2024-01-01", value: 1.0 / 0.0113, unit: "umol/L" },
          ],
          Glucose: [{ date: "2024-01-01", value: 90 / 18.02, unit: "mmol/L" }],
          "High-Sensitivity C-Reactive Protein (hs-CRP)": [
            { date: "2024-01-01", value: 0.05, unit: "mg/dL" },
          ],
        })
      ),
      demo("male", 45)
    );
    expect(find(r, "PhenoAge", "2024-01-01")?.value).toBeCloseTo(35.7, 0);
  });

  it("emits NOTHING on a partial panel (a missing analyte, no imputation)", () => {
    const draw = fullDraw("2024-01-01");
    delete draw["Red Cell Distribution Width (RDW)"]; // drop one of the nine required inputs
    const r = computeDerivedReadings(seriesOf(draw), demo("male", 45));
    expect(find(r, "PhenoAge", "2024-01-01")).toBeUndefined();
  });

  it("gates off child profiles (adult-only metric)", () => {
    const r = computeDerivedReadings(
      seriesOf(fullDraw("2024-01-01")),
      demo("female", 10)
    );
    expect(find(r, "PhenoAge", "2024-01-01")).toBeUndefined();
  });

  it("declines when chronological age is unknown (never guesses)", () => {
    const r = computeDerivedReadings(
      seriesOf(fullDraw("2024-01-01")),
      demo("male", null)
    );
    expect(find(r, "PhenoAge", "2024-01-01")).toBeUndefined();
  });

  // ── The glucose input's accepted siblings (#2334) ──────────────────────────
  //
  // A lab reporting a fasting panel imports the analyte under the curated
  // "Glucose, Fasting" entry, which is a DIFFERENT canonical name from "Glucose".
  // The input accepts both, fasting first — Levine's model is defined on fasting
  // serum glucose, so it is the better input where both exist, not a fallback.
  describe("its glucose input accepts the fasting sibling", () => {
    // The same draw with the glucose value filed under a chosen canonical name.
    function drawWithGlucose(
      date: string,
      under: Record<string, number>
    ): Record<string, ComponentReading[]> {
      const draw = fullDraw(date);
      delete draw["Glucose"];
      for (const [name, value] of Object.entries(under))
        draw[name] = [{ date, value, unit: "mg/dL" }];
      return draw;
    }

    it("computes from a draw carrying ONLY 'Glucose, Fasting'", () => {
      const r = computeDerivedReadings(
        seriesOf(drawWithGlucose("2024-01-01", { "Glucose, Fasting": 90 })),
        demo("male", 45)
      );
      const pheno = find(r, "PhenoAge", "2024-01-01");
      // Identical to the unqualified-glucose draw of the same value — the analyte
      // was always there, only the name differed.
      expect(pheno?.value).toBeCloseTo(35.7, 1);
      // The reading names the entry the value actually came from, so the surface
      // links to the series it was read out of.
      expect(pheno?.inputs.map((i) => i.name)).toContain("Glucose, Fasting");
      expect(pheno?.inputs.map((i) => i.name)).not.toContain("Glucose");
    });

    it("computes from a draw carrying ONLY the unqualified 'Glucose'", () => {
      const r = computeDerivedReadings(
        seriesOf(drawWithGlucose("2024-01-01", { Glucose: 90 })),
        demo("male", 45)
      );
      const pheno = find(r, "PhenoAge", "2024-01-01");
      expect(pheno?.value).toBeCloseTo(35.7, 1);
      expect(pheno?.inputs.map((i) => i.name)).toContain("Glucose");
    });

    it("PREFERS the fasting value when the draw carries both", () => {
      const r = computeDerivedReadings(
        seriesOf(
          drawWithGlucose("2024-01-01", {
            "Glucose, Fasting": 90,
            Glucose: 140,
          })
        ),
        demo("male", 45)
      );
      const pheno = find(r, "PhenoAge", "2024-01-01");
      const glucose = pheno?.inputs.find((i) => i.name === "Glucose, Fasting");
      expect(glucose?.value).toBe(90);
      // …and the result is the fasting-value answer, not the random-glucose one.
      expect(pheno?.value).toBeCloseTo(35.7, 1);
    });

    it("still declines when NEITHER glucose entry is on the draw", () => {
      const r = computeDerivedReadings(
        seriesOf(drawWithGlucose("2024-01-01", {})),
        demo("male", 45)
      );
      expect(find(r, "PhenoAge", "2024-01-01")).toBeUndefined();
    });

    it("leaves HOMA-IR's own acceptance list to HOMA-IR (#2357: the frame is now REQUIRED)", () => {
      // The acceptance list is per-input, so PhenoAge's preference never decides what
      // another index takes. HOMA-IR declares ["Glucose, Fasting"] alone — the fasting
      // frame is required, not preferred — so the fasting-only draw below computes and
      // the unqualified-only draw does not. Neither entry is folded into the other.
      const fasting = computeDerivedReadings(
        seriesOf({
          "Glucose, Fasting": [
            { date: "2024-01-01", value: 90, unit: "mg/dL" },
          ],
          Insulin: [{ date: "2024-01-01", value: 6, unit: "uIU/mL" }],
        }),
        demo("male", 45)
      );
      // (90 × 6) / 405 = 1.3333
      expect(find(fasting, HOMA_IR, "2024-01-01")?.value).toBeCloseTo(1.33, 2);

      const unqualified = computeDerivedReadings(
        seriesOf({
          Glucose: [{ date: "2024-01-01", value: 90, unit: "mg/dL" }],
          Insulin: [{ date: "2024-01-01", value: 6, unit: "uIU/mL" }],
        }),
        demo("male", 45)
      );
      expect(find(unqualified, HOMA_IR, "2024-01-01")).toBeUndefined();
    });
  });

  // ── Censored components (#2334) ────────────────────────────────────────────
  //
  // hs-CRP below the detection limit ("<0.2") is the COMMON, GOOD case. The app's
  // convention is substitute the limit, keep the marker, show it — so the draw
  // completes, and the marker travels to the result rather than being laundered
  // into an apparently exact biological age.
  describe("censored components", () => {
    const CENSORED_CRP = {
      "High-Sensitivity C-Reactive Protein (hs-CRP)": [
        {
          date: "2024-01-01",
          value: 0.2,
          unit: "mg/L",
          bound: "<" as const,
        },
      ],
    };

    it("computes the same value a reading exactly AT the limit would", () => {
      const censored = computeDerivedReadings(
        seriesOf(fullDraw("2024-01-01", CENSORED_CRP)),
        demo("male", 45)
      );
      const exact = computeDerivedReadings(
        seriesOf(
          fullDraw("2024-01-01", {
            "High-Sensitivity C-Reactive Protein (hs-CRP)": [
              { date: "2024-01-01", value: 0.2, unit: "mg/L" },
            ],
          })
        ),
        demo("male", 45)
      );
      expect(find(censored, "PhenoAge", "2024-01-01")?.value).toBe(
        find(exact, "PhenoAge", "2024-01-01")?.value
      );
    });

    it("carries the marker onto the input and the reading, and names the input", () => {
      const r = computeDerivedReadings(
        seriesOf(fullDraw("2024-01-01", CENSORED_CRP)),
        demo("male", 45)
      );
      const pheno = find(r, "PhenoAge", "2024-01-01");
      const crp = pheno?.inputs.find((i) =>
        i.name.startsWith("High-Sensitivity")
      );
      expect(crp?.bound).toBe("<");
      expect(pheno?.censored?.inputs).toEqual([
        {
          name: "High-Sensitivity C-Reactive Protein (hs-CRP)",
          label: "CRP",
          bound: "<",
        },
      ]);
      // The substituted formula string keeps the marker too.
      expect(pheno?.formula).toContain("CRP <0.2");
    });

    it("states the bias direction from the index's declared input directions", () => {
      // hs-CRP RAISES PhenoAge and the true value is BELOW the limit, so the
      // computed age can only be an over-estimate from that term.
      const r = computeDerivedReadings(
        seriesOf(fullDraw("2024-01-01", CENSORED_CRP)),
        demo("male", 45)
      );
      expect(find(r, "PhenoAge", "2024-01-01")?.censored?.bias).toBe("over");
    });

    it("flips the bias for an input that LOWERS the index", () => {
      // Albumin carries a negative coefficient: a below-limit albumin substituted
      // at its limit can only make the age too LOW.
      const r = computeDerivedReadings(
        seriesOf(
          fullDraw("2024-01-01", {
            Albumin: [
              { date: "2024-01-01", value: 2, unit: "g/dL", bound: "<" },
            ],
          })
        ),
        demo("male", 45)
      );
      expect(find(r, "PhenoAge", "2024-01-01")?.censored?.bias).toBe("under");
    });

    it("says nothing about censoring on an all-exact draw", () => {
      const r = computeDerivedReadings(
        seriesOf(fullDraw("2024-01-01")),
        demo("male", 45)
      );
      const pheno = find(r, "PhenoAge", "2024-01-01");
      expect(pheno?.censored).toBeUndefined();
      expect(pheno?.inputs.every((i) => i.bound === undefined)).toBe(true);
    });

    it("still declines when a censored component is not a usable number at all", () => {
      // ln(CRP) is undefined at zero: a ">"-bounded zero is still zero. The
      // censoring convention substitutes, it does not invent.
      const r = computeDerivedReadings(
        seriesOf(
          fullDraw("2024-01-01", {
            "High-Sensitivity C-Reactive Protein (hs-CRP)": [
              { date: "2024-01-01", value: 0, unit: "mg/L", bound: "<" },
            ],
          })
        ),
        demo("male", 45)
      );
      expect(find(r, "PhenoAge", "2024-01-01")).toBeUndefined();
    });
  });
});

describe("computeDerivedReadings — pairing rules", () => {
  it("requires all inputs on the same draw date (windowDays 0)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205, unit: "mg/dL" },
        ],
        "HDL Cholesterol": [{ date: "2024-02-15", value: 47, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Non-HDL Cholesterol", "2024-01-01")).toBeUndefined();
  });

  it("pairs the nearest input within a loosened window", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205, unit: "mg/dL" },
        ],
        "HDL Cholesterol": [{ date: "2024-01-03", value: 47, unit: "mg/dL" }],
      }),
      noDemo,
      { windowDays: 3 }
    );
    expect(find(r, "Non-HDL Cholesterol", "2024-01-01")?.value).toBe(158);
  });

  it("skips a draw that already has a stored reading of the derived analyte", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205, unit: "mg/dL" },
          { date: "2024-06-01", value: 190, unit: "mg/dL" },
        ],
        "HDL Cholesterol": [
          { date: "2024-01-01", value: 47, unit: "mg/dL" },
          { date: "2024-06-01", value: 53, unit: "mg/dL" },
        ],
      }),
      noDemo,
      {
        storedDatesByName: {
          "Non-HDL Cholesterol": new Set(["2024-01-01"]),
        },
      }
    );
    expect(find(r, "Non-HDL Cholesterol", "2024-01-01")).toBeUndefined();
    expect(find(r, "Non-HDL Cholesterol", "2024-06-01")?.value).toBe(137);
  });

  it("computes a full multi-draw series in chronological order", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205, unit: "mg/dL" },
          { date: "2024-06-01", value: 190, unit: "mg/dL" },
        ],
        "HDL Cholesterol": [
          { date: "2024-01-01", value: 47, unit: "mg/dL" },
          { date: "2024-06-01", value: 53, unit: "mg/dL" },
        ],
      }),
      noDemo
    );
    const nonHdl = r.filter((x) => x.name === "Non-HDL Cholesterol");
    expect(nonHdl.map((x) => [x.date, x.value])).toEqual([
      ["2024-01-01", 158],
      ["2024-06-01", 137],
    ]);
  });

  it("carries a human formula with substituted values", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: "2024-01-01", value: 205, unit: "mg/dL" },
        ],
        "HDL Cholesterol": [{ date: "2024-01-01", value: 47, unit: "mg/dL" }],
      }),
      noDemo
    );
    const reading = find(r, "Non-HDL Cholesterol", "2024-01-01");
    expect(reading?.formula).toContain("Total Cholesterol − HDL");
    expect(reading?.formula).toContain("158");
  });
});

// ── The #2300 indices ────────────────────────────────────────────────────────
// Every value below is an invented round number, not a reading from any corpus.

describe("computeDerivedReadings — urine albumin/creatinine ratio (ACR)", () => {
  const day = "2024-03-04";

  it("computes albumin ÷ urine creatinine, scaled to mg/g", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Albumin, Urine": [{ date: day, value: 3, unit: "mg/dL" }],
        "Creatinine, Urine": [{ date: day, value: 100, unit: "mg/dL" }],
      }),
      noDemo
    );
    const acr = find(r, "Microalbumin/Creatinine Ratio, Urine", day);
    expect(acr?.value).toBe(30);
    expect(acr?.unit).toBe("mg/g");
  });

  it("gives the SAME answer from the mg/L albumin a lab usually prints", () => {
    // 3 mg/dL == 30 mg/L. Dividing the mg/L value by a mg/dL creatinine without
    // converting first would read 300 mg/g — moderately increased albuminuria — off a
    // normal draw.
    const r = computeDerivedReadings(
      seriesOf({
        "Albumin, Urine": [{ date: day, value: 30, unit: "mg/L" }],
        "Creatinine, Urine": [{ date: day, value: 100, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Microalbumin/Creatinine Ratio, Urine", day)?.value).toBe(
      30
    );
  });

  // THE specimen guard. A panel commonly carries both creatinines, and in mg/dL they
  // differ by ~100× — so picking the serum one turns a normal 30 mg/g into 3000 mg/g,
  // landing a healthy result inside albuminuria staging.
  it("refuses to compute from SERUM creatinine when no urine creatinine exists", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Albumin, Urine": [{ date: day, value: 3, unit: "mg/dL" }],
        Creatinine: [{ date: day, value: 1, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(
      find(r, "Microalbumin/Creatinine Ratio, Urine", day)
    ).toBeUndefined();
  });

  it("takes the urine creatinine when BOTH specimens are on the draw", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Albumin, Urine": [{ date: day, value: 3, unit: "mg/dL" }],
        "Creatinine, Urine": [{ date: day, value: 100, unit: "mg/dL" }],
        Creatinine: [{ date: day, value: 1, unit: "mg/dL" }],
      }),
      demo("female", 40)
    );
    expect(find(r, "Microalbumin/Creatinine Ratio, Urine", day)?.value).toBe(
      30
    );
  });

  it("declines a non-positive urine creatinine (divide-by-zero guard)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Albumin, Urine": [{ date: day, value: 3, unit: "mg/dL" }],
        "Creatinine, Urine": [{ date: day, value: 0, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(
      find(r, "Microalbumin/Creatinine Ratio, Urine", day)
    ).toBeUndefined();
  });
});

describe("computeDerivedReadings — urine protein/creatinine ratio", () => {
  const day = "2024-03-04";

  it("computes protein ÷ urine creatinine, scaled to mg/g", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Protein, Urine": [{ date: day, value: 15, unit: "mg/dL" }],
        "Creatinine, Urine": [{ date: day, value: 100, unit: "mg/dL" }],
      }),
      noDemo
    );
    const pcr = find(r, "Protein/Creatinine Ratio, Urine", day);
    expect(pcr?.value).toBe(150);
    expect(pcr?.unit).toBe("mg/g");
  });

  // The trap the declared input unit closes: `Protein, Urine` is curated UNITLESS (the
  // dipstick pad), and convertToCanonical treats a null canonical unit as "already
  // canonical" — so without a unit on the spec a mg/L row and a mg/dL row would both
  // pass through and divide 10× apart.
  it("converts a mg/L protein to mg/dL before dividing", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Protein, Urine": [{ date: day, value: 150, unit: "mg/L" }],
        "Creatinine, Urine": [{ date: day, value: 100, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Protein/Creatinine Ratio, Urine", day)?.value).toBe(150);
  });

  it("refuses SERUM creatinine here too", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Protein, Urine": [{ date: day, value: 15, unit: "mg/dL" }],
        Creatinine: [{ date: day, value: 1, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "Protein/Creatinine Ratio, Urine", day)).toBeUndefined();
  });
});

describe("computeDerivedReadings — HDL as % of Cholesterol", () => {
  const day = "2024-03-04";

  it("computes HDL ÷ total cholesterol × 100", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [{ date: day, value: 200, unit: "mg/dL" }],
        "HDL Cholesterol": [{ date: day, value: 50, unit: "mg/dL" }],
      }),
      noDemo
    );
    const pct = find(r, "HDL as % of Cholesterol", day);
    expect(pct?.value).toBe(25);
    expect(pct?.unit).toBe("%");
  });

  it("gives the same percentage from mmol/L inputs (converted first)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [
          { date: day, value: 200 / 38.67, unit: "mmol/L" },
        ],
        "HDL Cholesterol": [{ date: day, value: 50 / 38.67, unit: "mmol/L" }],
      }),
      noDemo
    );
    expect(find(r, "HDL as % of Cholesterol", day)?.value).toBe(25);
  });

  it("declines a non-positive total cholesterol (divide-by-zero guard)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Total Cholesterol": [{ date: day, value: 0, unit: "mg/dL" }],
        "HDL Cholesterol": [{ date: day, value: 50, unit: "mg/dL" }],
      }),
      noDemo
    );
    expect(find(r, "HDL as % of Cholesterol", day)).toBeUndefined();
  });
});

describe("computeDerivedReadings — Omega-6 Total", () => {
  const day = "2024-03-04";

  it("computes the omega-6/omega-3 ratio × the omega-3 total", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Omega-6/Omega-3 Ratio": [{ date: day, value: 5, unit: "ratio" }],
        "Omega-3 Total (OmegaCheck)": [
          { date: day, value: 6, unit: "% by wt" },
        ],
      }),
      noDemo
    );
    const total = find(r, "Omega-6 Total", day);
    expect(total?.value).toBe(30);
    expect(total?.unit).toBe("% by wt");
  });

  // THE derivation trap: arachidonic + linoleic is the obvious route and it
  // understates the printed total by DGLA and the minor omega-6 species the panel
  // never itemizes. Here the itemized lines sum to 29 while the true total is 30 —
  // the index must ignore them entirely.
  it("does NOT sum the itemized omega-6 components", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Omega-6/Omega-3 Ratio": [{ date: day, value: 5, unit: "ratio" }],
        "Omega-3 Total (OmegaCheck)": [
          { date: day, value: 6, unit: "% by wt" },
        ],
        "Omega-6 Arachidonic Acid": [{ date: day, value: 9, unit: "% by wt" }],
        "Omega-6 Linoleic Acid": [{ date: day, value: 20, unit: "% by wt" }],
      }),
      noDemo
    );
    expect(find(r, "Omega-6 Total", day)?.value).toBe(30);
  });

  it("emits nothing when only the itemized components are on the draw", () => {
    const r = computeDerivedReadings(
      seriesOf({
        "Omega-6 Arachidonic Acid": [{ date: day, value: 9, unit: "% by wt" }],
        "Omega-6 Linoleic Acid": [{ date: day, value: 20, unit: "% by wt" }],
      }),
      noDemo
    );
    expect(find(r, "Omega-6 Total", day)).toBeUndefined();
  });
});

// Bilirubin, Indirect is a canonical entry WITHOUT a derived spec, on purpose: when
// either component is reported below its detection limit the subtraction is undefined
// and labs print "Can't Calc" rather than guess (#2300 §3).
describe("Bilirubin, Indirect is curated but never computed", () => {
  it("has a canonical entry and no derived spec", () => {
    expect(canonicalBiomarkerForName("Bilirubin, Indirect")).toBeTruthy();
    expect(DERIVED_NAMES).not.toContain("Bilirubin, Indirect");
  });
});

describe("derivedInputCanonicalNames", () => {
  it("lists every distinct component analyte", () => {
    expect(new Set(derivedInputCanonicalNames())).toEqual(
      new Set([
        "Total Cholesterol",
        "LDL Cholesterol",
        "HDL Cholesterol",
        "Triglycerides",
        "Glucose",
        // PhenoAge's glucose input accepts the fasting sibling too, so BOTH series
        // must be loaded for it (#2334).
        "Glucose, Fasting",
        "Insulin",
        "Creatinine",
        "Albumin",
        "High-Sensitivity C-Reactive Protein (hs-CRP)",
        "Lymphocytes, Relative",
        "Mean Corpuscular Volume (MCV)",
        "Red Cell Distribution Width (RDW)",
        "Alkaline Phosphatase",
        "White Blood Cell Count",
        "Albumin, Urine",
        "Creatinine, Urine",
        "Protein, Urine",
        "Omega-6/Omega-3 Ratio",
        "Omega-3 Total (OmegaCheck)",
      ])
    );
  });

  it("lists an input's accepted siblings as separate series to load", () => {
    // The query layer keys the series map by exact canonical name, so BOTH glucose
    // entries have to be asked for — and they stay separate series, never folded.
    const names = derivedInputCanonicalNames();
    expect(names).toContain("Glucose");
    expect(names).toContain("Glucose, Fasting");
  });

  it("gives PhenoAge nine input KEYS, one per input, glucose under its preferred name", () => {
    const keys = derivedInputKeysFor("PhenoAge");
    expect(keys).toHaveLength(9);
    expect(keys).toContain("Glucose, Fasting");
    expect(keys).not.toContain("Glucose");
    expect(derivedInputKeysFor("Not An Index")).toEqual([]);
  });

  it("reports BOTH accepted spellings as PhenoAge's inputs for the retest clock", () => {
    // The freshness question is "has this input been redrawn?", and either entry
    // answers it — so the clock must see both.
    const names = derivedInputCanonicalNamesFor("PhenoAge");
    expect(names).toContain("Glucose, Fasting");
    expect(names).toContain("Glucose");
  });

  it("gives HOMA-IR a glucose input that accepts ONLY the fasting entry (#2357)", () => {
    // The acceptance list is what every downstream consumer reads — the retest clock,
    // the Upcoming coverage gap — so the requirement is pinned here, not only in the
    // arithmetic. The unqualified entry is absent on purpose: it is the one for a draw
    // whose fasting state is unknown (#2337), and this index asserts that frame.
    const names = derivedInputCanonicalNamesFor(HOMA_IR);
    expect(names).toEqual(["Glucose, Fasting", "Insulin"]);
    expect(derivedInputKeysFor(HOMA_IR)).toEqual([
      "Glucose, Fasting",
      "Insulin",
    ]);
  });

  it("groups the input slots by key, each with the names it accepts", () => {
    // A UNION across the indices sharing the key: HOMA-IR contributes only the fasting
    // entry, PhenoAge both (see derivedInputSlots' note on who may read this).
    const slot = derivedInputSlots().find((s) => s.key === "Glucose, Fasting");
    expect(slot?.accepts).toEqual(["Glucose, Fasting", "Glucose"]);
  });

  it("asks for the URINE creatinine as its own series, not the serum one (#2300)", () => {
    // The two are separate keys in the series map the query layer fills, which is what
    // makes the ACR/PCR specimen guard structural rather than a naming convention.
    const names = derivedInputCanonicalNames();
    expect(names).toContain("Creatinine, Urine");
    expect(names).toContain("Creatinine");
  });
});

// The registry is only half the contract: every index it emits must ALSO exist as a
// canonical_biomarkers row, or the shared range/flag/panel machinery has nothing to
// judge the computed value against and it renders as a band-less orphan. This guards
// the committed dataset against drifting away from the registry (#1582).
describe("derived indices ↔ the canonical dataset", () => {
  it("every derived name has a canonical row whose unit the deriver emits", () => {
    for (const name of DERIVED_NAMES) {
      const cb = canonicalBiomarkerForName(name);
      expect(
        cb,
        `${name} is missing from canonical-biomarkers.json`
      ).toBeTruthy();
      expect(cb?.unit ?? null, `${name} unit`).toBe(
        DERIVED_DEFS_BY_NAME[name].unit
      );
    }
  });

  it("keeps the two glucose entries DISTINCT everywhere outside the input (#2334)", () => {
    // PhenoAge's input accepts either spelling; the dataset and the identity model
    // must not follow it. Both are curated rows with their own reference bands, and
    // they are separate families — so nothing dedups them, marks one current off the
    // other, or judges a fasting glucose against the unqualified entry's band.
    // Two separate curated rows (each carrying its own bands, whatever those are)…
    expect(canonicalBiomarkerForName("Glucose, Fasting")?.name).toBe(
      "Glucose, Fasting"
    );
    expect(canonicalBiomarkerForName("Glucose")?.name).toBe("Glucose");
    // …and two separate identities, which is what keeps the dedup partition, the
    // is_latest marker and the flag path from ever treating one as the other.
    expect(biomarkerFamily("Glucose, Fasting")).not.toBe(
      biomarkerFamily("Glucose")
    );
  });

  it("puts the lipid indices on the lipids panel, beside their components", () => {
    for (const name of [
      "Non-HDL Cholesterol",
      "Cholesterol/HDL Ratio",
      "LDL/HDL Ratio",
      "Triglyceride/HDL Ratio",
    ] as const)
      expect(panelForCanonicalName(name), name).toBe("lipids");
  });

  it("normalizes the ratio spellings a lab prints onto the canonical names", () => {
    const index = buildCanonicalIndex(
      (canonicalSeed as { biomarkers: { name: string }[] }).biomarkers.map(
        (b) => b.name
      )
    );
    const resolve = (s: string) => index.get(normalizeCanonicalKey(s));
    for (const spelling of [
      "LDL/HDL Ratio",
      "LDL/HDL",
      "LDL:HDL Ratio",
      "LDL/HDL Cholesterol Ratio",
    ])
      expect(resolve(spelling), spelling).toBe("LDL/HDL Ratio");
    for (const spelling of [
      "Cholesterol/HDL Ratio",
      "Cholesterol HDL Ratio",
      "Total Cholesterol/HDL Ratio",
    ])
      expect(resolve(spelling), spelling).toBe("Cholesterol/HDL Ratio");

    // NOT aliased, deliberately: a bare "Cholesterol/HDL" carries exactly the token
    // set of "HDL Cholesterol", so routing it to the ratio would hijack a distinct
    // analyte on a guess.
    expect(resolve("Cholesterol/HDL")).toBe("HDL Cholesterol");
  });
});

// ── PhenoAge leave-one-out effects (#2366) ───────────────────────────────────
//
// "Which input is moving my number, and by how much?" answered as a COUNTERFACTUAL in
// years: re-run the whole model with one input at a reference value, report the
// difference. These pin the definition (not a share of `xb`), the ordering, the
// absent-reference case, and — the acceptance test — that the decomposition and the
// engine's own number are the same computation.
describe("computeDerivedReadings — PhenoAge input effects (#2366)", () => {
  const DATE = "2024-01-01";

  // The same nine-analyte canonical-unit draw the PhenoAge suite above uses.
  const DRAW: Record<string, number> = {
    Albumin: 4.7,
    Creatinine: 1.0,
    "Glucose, Fasting": 90,
    "High-Sensitivity C-Reactive Protein (hs-CRP)": 0.5,
    "Lymphocytes, Relative": 35,
    "Mean Corpuscular Volume (MCV)": 90,
    "Red Cell Distribution Width (RDW)": 13,
    "Alkaline Phosphatase": 65,
    "White Blood Cell Count": 5.5,
  };

  const UNITS: Record<string, string> = {
    Albumin: "g/dL",
    Creatinine: "mg/dL",
    "Glucose, Fasting": "mg/dL",
    "High-Sensitivity C-Reactive Protein (hs-CRP)": "mg/L",
    "Lymphocytes, Relative": "%",
    "Mean Corpuscular Volume (MCV)": "fL",
    "Red Cell Distribution Width (RDW)": "%",
    "Alkaline Phosphatase": "U/L",
    "White Blood Cell Count": "10^3/uL",
  };

  // Synthetic reference values, one per input — the RULE that picks them from the
  // curated bands is lib/bio-age's and is tested there; what matters here is that the
  // counterfactual uses whatever it is handed.
  const REFS: Record<string, number> = {
    Albumin: 4.7,
    Creatinine: 0.95,
    "Glucose, Fasting": 80,
    "High-Sensitivity C-Reactive Protein (hs-CRP)": 1,
    "Lymphocytes, Relative": 32.5,
    "Mean Corpuscular Volume (MCV)": 90,
    "Red Cell Distribution Width (RDW)": 12.25,
    "Alkaline Phosphatase": 84.5,
    "White Blood Cell Count": 7.1,
  };

  function series(
    over: Record<string, ComponentReading[]> = {}
  ): Map<string, ComponentReading[]> {
    return seriesOf({
      ...Object.fromEntries(
        Object.entries(DRAW).map(([name, value]) => [
          name,
          [{ date: DATE, value, unit: UNITS[name] }],
        ])
      ),
      ...over,
    });
  }

  // Every input referenced, except any name in `without` — the absent-reference case.
  function resolver(without: string[] = []): PhenoAgeReferenceResolver {
    return ({ key, name }) =>
      without.includes(name) || REFS[key] == null
        ? null
        : { value: REFS[key], basis: "optimal" };
  }

  // The model evaluated directly from a canonical-unit draw, for reconciliation.
  function model(vals: Record<string, number>, age: number): number {
    const v = phenoAge({
      albuminGL: vals["Albumin"] * 10,
      creatinineUmolL: vals["Creatinine"] * 88.4017,
      glucoseMmolL: vals["Glucose, Fasting"] / 18.0182,
      crpMgDl: vals["High-Sensitivity C-Reactive Protein (hs-CRP)"] / 10,
      lymphocytePct: vals["Lymphocytes, Relative"],
      mcvFl: vals["Mean Corpuscular Volume (MCV)"],
      rdwPct: vals["Red Cell Distribution Width (RDW)"],
      alpUL: vals["Alkaline Phosphatase"],
      wbcThousandUl: vals["White Blood Cell Count"],
      ageYears: age,
    });
    if (v == null) throw new Error("model declined on a complete draw");
    return v;
  }

  function effectsOf(
    resolve: PhenoAgeReferenceResolver,
    over: Record<string, ComponentReading[]> = {}
  ) {
    const r = computeDerivedReadings(series(over), demo("male", 45), {
      phenoAgeReference: resolve,
    });
    const pheno = find(r, "PhenoAge", DATE);
    if (!pheno?.effects) throw new Error("no PhenoAge effects");
    return { pheno, effects: pheno.effects };
  }

  it("attaches NOTHING without a reference resolver (no extra model runs)", () => {
    const r = computeDerivedReadings(series(), demo("male", 45));
    expect(find(r, "PhenoAge", DATE)?.effects).toBeUndefined();
  });

  it("reports the nine analytes plus chronological age, ranked by absolute years", () => {
    const { effects } = effectsOf(resolver());
    expect(effects).toHaveLength(10);
    // Chronological age is IN the list, not hidden: it is a term in the predictor and
    // usually the dominant one, and seeing that is what stops the number reading as a
    // verdict on the labs alone.
    expect(effects.map((e) => e.key)).toContain(AGE_INPUT_KEY);
    const magnitudes = effects.map((e) => Math.abs(e.effectYears ?? 0));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
    // Each row carries the value the claim is checkable against.
    const rdw = effects.find(
      (e) => e.key === "Red Cell Distribution Width (RDW)"
    );
    expect(rdw?.value).toBe(13);
    expect(rdw?.unit).toBe("%");
    expect(rdw?.reference).toEqual({ value: 12.25, basis: "optimal" });
  });

  // THE ACCEPTANCE TEST. Each row is the engine's own result minus the engine re-run
  // with that one input moved — computed here from the published formula directly, so
  // a decomposition that drifted from the model would fail rather than agree with
  // itself.
  it("reconciles: every counterfactual reproduces the engine's own number", () => {
    const { pheno, effects } = effectsOf(resolver());
    const baseline = model(DRAW, 45);
    expect(pheno.value).toBeCloseTo(baseline, 1);
    for (const e of effects) {
      const counterfactual =
        e.key === AGE_INPUT_KEY
          ? model(DRAW, PHENOAGE_MIN_AGE)
          : model({ ...DRAW, [e.key]: e.reference!.value }, 45);
      // To the display precision the row is stated in (1 dp) — the rounding is the
      // ONLY difference between the two paths.
      expect(e.effectYears, e.key).toBeCloseTo(baseline - counterfactual, 1);
    }
  });

  it("moves the AGE row to the model's own floor — no invented optimal age", () => {
    const { effects } = effectsOf(resolver());
    const age = effects.find((e) => e.key === AGE_INPUT_KEY);
    expect(age?.reference).toEqual({
      value: PHENOAGE_MIN_AGE,
      basis: "model-floor",
    });
    expect(age?.value).toBe(45);
    expect(age?.unit).toBe("years");
    // A 45-year-old's age term dominates a healthy panel — the point of showing it.
    expect(age?.effectYears).toBeGreaterThan(0);
    expect(effects[0].key).toBe(AGE_INPUT_KEY);
  });

  it("reports an input with NO curated reference as absent, never as zero, and last", () => {
    // The live case: a draw carrying the unqualified, deliberately band-less "Glucose"
    // (#2337) instead of the fasting entry. The input still computed the number; what
    // it has no basis for is a target to compare against.
    const { effects } = effectsOf(resolver(["Glucose"]), {
      "Glucose, Fasting": [],
      Glucose: [{ date: DATE, value: 90, unit: "mg/dL" }],
    });
    const glucose = effects.find((e) => e.name === "Glucose");
    expect(glucose).toBeDefined();
    expect(glucose!.effectYears).toBeNull();
    expect(glucose!.effectYears).not.toBe(0);
    expect(glucose!.reference).toBeNull();
    // Sorted after every row that HAS a comparison — an unanswerable question is not
    // a small answer.
    expect(effects[effects.length - 1].name).toBe("Glucose");
    expect(effects.filter((e) => e.effectYears != null)).toHaveLength(9);
  });

  it("carries a CENSORED input's marker onto its effect row (#2334)", () => {
    // hs-CRP below the detection limit: the value is the substituted limit, so the
    // effect computed from it is bounded too and the row has to say so.
    const { effects } = effectsOf(resolver(), {
      "High-Sensitivity C-Reactive Protein (hs-CRP)": [
        { date: DATE, value: 0.2, unit: "mg/L", bound: "<" },
      ],
    });
    const crp = effects.find((e) => e.label === "CRP");
    expect(crp?.bound).toBe("<");
    expect(crp?.value).toBe(0.2);
    expect(crp?.effectYears).not.toBeNull();
  });

  it("publishes each input's declared canonical unit, keyed by input key", () => {
    // A caller comparing a curated band against an input's value has to state it in
    // the unit the FORMULA consumes; the dataset entry's own unit is not always that
    // unit, so the declaration is read from the spec rather than re-guessed.
    const units = derivedInputUnitsFor("PhenoAge");
    expect(Object.keys(units)).toHaveLength(9);
    expect(units["High-Sensitivity C-Reactive Protein (hs-CRP)"]).toBe("mg/L");
    expect(units["Glucose, Fasting"]).toBe("mg/dL");
    expect(derivedInputUnitsFor("Not An Index")).toEqual({});
  });

  it("names the glucose entry the value actually came from", () => {
    const { effects } = effectsOf(resolver());
    const glucose = effects.find((e) => e.label === "Glu");
    expect(glucose?.key).toBe("Glucose, Fasting");
    expect(glucose?.name).toBe("Glucose, Fasting");
  });
});
