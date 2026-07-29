import { describe, expect, it } from "vitest";
import { isRetestWorthy, retestDaysForBiomarker } from "@/lib/biomarker-retest";
import {
  BIOMARKER_FAMILIES,
  biomarkerRetestIdentity,
} from "@/lib/canonical-name";
import { CANONICAL_BIOMARKERS } from "@/lib/datasets/canonical-biomarkers";

describe("retestDaysForBiomarker", () => {
  it("reads the curated cadence, case-insensitively", () => {
    expect(retestDaysForBiomarker("Hemoglobin A1c")).toBe(90);
    expect(retestDaysForBiomarker("hemoglobin a1c")).toBe(90);
  });

  it("is null for an uncurated / unknown analyte", () => {
    expect(retestDaysForBiomarker("Mercury")).toBeNull();
    expect(retestDaysForBiomarker(null)).toBeNull();
    expect(retestDaysForBiomarker("   ")).toBeNull();
  });

  it("gives every A1c-family spelling the A1c cadence, incl. eAG (#1394/#1395)", () => {
    // The retest CLOCK folds A1c and its eAG re-expression into one family, so the
    // INTERVAL must resolve on that same identity. The dataset names only
    // "Hemoglobin A1c"; before the fix a family whose newest reading was the eAG
    // line (labs report both on one draw, eAG lands with the higher id) fell to the
    // flat 365-day default — a diabetic's quarterly A1c nudged annually.
    for (const name of [
      "Hemoglobin A1c",
      "HbA1c",
      "A1c",
      "Hgb A1c",
      "Glycated Hemoglobin",
      "Glycosylated Hemoglobin",
      "Glycohemoglobin",
      "Estimated Average Glucose",
      "eAG",
      // Freeform spellings the family's `match` catches but no list enumerates.
      "HbA1c (Whole Blood)",
      "Estimated Average Glucose (eAG)",
    ]) {
      expect(retestDaysForBiomarker(name)).toBe(90);
    }
  });

  it("gives every 25-OH vitamin-D member the shared 180-day clock (#1193)", () => {
    for (const name of [
      "Vitamin D, 25-Hydroxy",
      "Vitamin D, Total",
      "Vitamin D",
      "25-OH Vitamin D",
      "Vitamin D2, 25-Hydroxy",
      "Vitamin D3, 25-Hydroxy",
      "Ergocalciferol",
      "25-OH Vitamin D3 (Cholecalciferol)",
    ]) {
      expect(retestDaysForBiomarker(name)).toBe(180);
    }
    // The deliberately EXCLUDED vitamin-D analytes keep their own (absent) cadence —
    // the active metabolite must never inherit the storage form's clock.
    expect(retestDaysForBiomarker("Vitamin D, 1,25-Dihydroxy")).toBeNull();
    expect(retestDaysForBiomarker("Calcitriol")).toBeNull();
  });

  it("never leaks a family cadence onto a neighbouring analyte", () => {
    // A plain fasting/random glucose is NOT the A1c family — it keeps its own
    // curated 180, and an uncurated neighbour stays uncurated.
    expect(retestDaysForBiomarker("Glucose")).toBe(180);
    expect(retestDaysForBiomarker("Glucose, Fasting")).toBe(180);
    expect(retestDaysForBiomarker("Glucose, Urine")).toBeNull();
    expect(retestDaysForBiomarker("Vitamin D Binding Protein")).toBeNull();
  });

  it("keeps every curated analyte's own cadence (no widening regression)", () => {
    // Structural guard for the identity-keyed lookup: folding members onto one clock
    // must never LOOSEN a curated analyte's interval, and a non-family analyte must
    // still resolve to exactly its own curated number.
    for (const b of CANONICAL_BIOMARKERS) {
      if (typeof b.retest_days !== "number" || b.retest_days <= 0) continue;
      const resolved = retestDaysForBiomarker(b.name);
      expect(resolved).not.toBeNull();
      expect(resolved!).toBeLessThanOrEqual(b.retest_days);
    }
  });

  it("leaves no family member on the flat default when a sibling is curated", () => {
    // The hole #1395 reports, closed by construction: if ANY member of a family has
    // a curated cadence, EVERY enumerated member resolves to one.
    for (const fam of BIOMARKER_FAMILIES) {
      const curated = fam.members.filter(
        (m) => retestDaysForBiomarker(m) !== null
      );
      if (curated.length === 0) continue;
      for (const member of fam.members) {
        expect(retestDaysForBiomarker(member)).not.toBeNull();
      }
      // …and they all read the SAME clock, since they share one retest identity.
      const identities = new Set(
        fam.members.map((m) => biomarkerRetestIdentity(m))
      );
      expect(identities.size).toBe(1);
      const days = new Set(fam.members.map((m) => retestDaysForBiomarker(m)));
      expect(days.size).toBe(1);
    }
  });
});

describe("isRetestWorthy (#546 recurring-monitoring tier)", () => {
  it("recognizes the core recurring-monitoring analytes", () => {
    for (const n of [
      "Total Cholesterol",
      "Hemoglobin A1c",
      "Thyroid-Stimulating Hormone (TSH)",
      "Creatinine",
      "Alanine Aminotransferase (ALT)",
      "Hemoglobin",
      "High-Sensitivity C-Reactive Protein (hs-CRP)",
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
