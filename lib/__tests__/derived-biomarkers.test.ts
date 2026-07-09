import { describe, it, expect } from "vitest";
import {
  computeDerivedReadings,
  ckdEpi2021,
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
      ])
    );
  });
});
