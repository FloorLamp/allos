import { describe, it, expect } from "vitest";
import {
  computeDerivedReadings,
  ckdEpi2021,
  phenoAge,
  derivedInputCanonicalNames,
  type ComponentReading,
  type DerivedDemographics,
} from "../derived-biomarkers";

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

describe("computeDerivedReadings — HOMA-IR", () => {
  it("computes (glucose mg/dL × insulin µU/mL) ÷ 405", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Glucose: [{ date: "2024-01-01", value: 96, unit: "mg/dL" }],
        Insulin: [{ date: "2024-01-01", value: 9.5, unit: "uIU/mL" }],
      }),
      noDemo
    );
    // (96 × 9.5) / 405 = 2.2519
    expect(find(r, "HOMA-IR", "2024-01-01")?.value).toBeCloseTo(2.25, 2);
  });

  it("matches from mmol/L glucose + pmol/L insulin (converted first)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Glucose: [{ date: "2024-01-01", value: 96 / 18.02, unit: "mmol/L" }],
        Insulin: [{ date: "2024-01-01", value: 9.5 / 0.1439, unit: "pmol/L" }],
      }),
      noDemo
    );
    expect(find(r, "HOMA-IR", "2024-01-01")?.value).toBeCloseTo(2.25, 1);
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
    expect(find(r, "eGFR", "2024-01-01")?.value).toBe(111);
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
    expect(find(r, "eGFR", "2024-01-01")?.value).toBe(111);
  });

  it("declines eGFR when sex is unknown (never guesses)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo(null, 40)
    );
    expect(find(r, "eGFR", "2024-01-01")).toBeUndefined();
  });

  it("declines eGFR when age is unknown (never guesses)", () => {
    const r = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo("male", null)
    );
    expect(find(r, "eGFR", "2024-01-01")).toBeUndefined();
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
    expect(find(child, "eGFR", "2024-01-01")).toBeUndefined();
    // Still produced for an adult at exactly the floor.
    const adult = computeDerivedReadings(
      seriesOf({
        Creatinine: [{ date: "2024-01-01", value: 0.9, unit: "mg/dL" }],
      }),
      demo("male", 18)
    );
    expect(find(adult, "eGFR", "2024-01-01")?.value).toBeGreaterThan(0);
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
      "hs-CRP": [{ date, value: 0.5, unit: "mg/L" }],
      Lymphocytes: [{ date, value: 35, unit: "%" }],
      MCV: [{ date, value: 90, unit: "fL" }],
      RDW: [{ date, value: 13, unit: "%" }],
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
          "hs-CRP": [{ date: "2024-01-01", value: 0.05, unit: "mg/dL" }],
        })
      ),
      demo("male", 45)
    );
    expect(find(r, "PhenoAge", "2024-01-01")?.value).toBeCloseTo(35.7, 0);
  });

  it("emits NOTHING on a partial panel (a missing analyte, no imputation)", () => {
    const draw = fullDraw("2024-01-01");
    delete draw["RDW"]; // drop one of the nine required inputs
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

describe("derivedInputCanonicalNames", () => {
  it("lists every distinct component analyte", () => {
    expect(new Set(derivedInputCanonicalNames())).toEqual(
      new Set([
        "Total Cholesterol",
        "HDL Cholesterol",
        "Triglycerides",
        "Glucose",
        "Insulin",
        "Creatinine",
        "Albumin",
        "hs-CRP",
        "Lymphocytes",
        "MCV",
        "RDW",
        "Alkaline Phosphatase",
        "White Blood Cell Count",
      ])
    );
  });
});
