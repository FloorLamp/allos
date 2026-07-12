import { describe, expect, it } from "vitest";
import { isRetestWorthy, retestDaysForBiomarker } from "@/lib/biomarker-retest";

describe("retestDaysForBiomarker", () => {
  it("reads the curated cadence, case-insensitively", () => {
    expect(retestDaysForBiomarker("Hemoglobin A1c")).toBe(90);
    expect(retestDaysForBiomarker("hemoglobin a1c")).toBe(90);
  });

  it("is null for an uncurated / unknown analyte", () => {
    expect(retestDaysForBiomarker("Mercury")).toBeNull();
    expect(retestDaysForBiomarker(null)).toBeNull();
  });
});

describe("isRetestWorthy (#546 recurring-monitoring tier)", () => {
  it("recognizes the core recurring-monitoring analytes", () => {
    for (const n of [
      "Total Cholesterol",
      "Hemoglobin A1c",
      "TSH",
      "Creatinine",
      "ALT",
      "Hemoglobin",
      "hs-CRP",
      "Vitamin D, 25-Hydroxy",
    ]) {
      expect(isRetestWorthy(n)).toBe(true);
    }
  });

  it("is family-aware: the vitamin-D 25-OH isoforms inherit worthiness", () => {
    expect(isRetestWorthy("Vitamin D2, 25-Hydroxy")).toBe(true);
    expect(isRetestWorthy("Vitamin D3, 25-Hydroxy")).toBe(true);
  });

  it("excludes incidental one-offs (heavy metals, PFAS, allergen IgE, subfractions)", () => {
    for (const n of [
      "Mercury",
      "Lead",
      "PFAS - PFHxS",
      "Birch (T3) IgE",
      "LDL Small",
      "Vitamin D, 1,25-Dihydroxy",
      "Selenium",
    ]) {
      expect(isRetestWorthy(n)).toBe(false);
    }
    expect(isRetestWorthy(null)).toBe(false);
  });
});
