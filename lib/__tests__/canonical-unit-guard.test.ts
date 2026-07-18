import { describe, it, expect } from "vitest";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import { buildCanonicalIndex } from "@/lib/canonical-name";
import { unitAwareCanonical, seededUnitFor } from "@/lib/canonical-unit-guard";
import { normalizeResults } from "@/lib/medical-extract";

const vocab = (
  canonicalSeed as { biomarkers: { name: string }[] }
).biomarkers.map((b) => b.name);
const index = buildCanonicalIndex(vocab);
const g = (snapped: string, printed: string, unit: string | null) =>
  unitAwareCanonical(snapped, printed, unit, index);

describe("unitAwareCanonical — the unit is the arbiter (#918 §1)", () => {
  it("re-routes a count value off a '%' entry to the absolute sibling", () => {
    // Model named an absolute lymphocyte count "Lymphocytes" — the % entry. The
    // cells/uL unit contradicts it; the count sibling is the right home.
    expect(g("Lymphocytes", "ABSOLUTE LYMPHOCYTES", "cells/uL")).toBe(
      "Lymphocytes, Absolute"
    );
  });

  it("re-routes a '%' value off a count entry to the relative sibling", () => {
    // The bare Monocytes/Eosinophils/Basophils entries are the cells/uL counts; a
    // "%" value belongs on the ", Relative" sibling.
    expect(g("Monocytes", "MONOCYTES", "%")).toBe("Monocytes, Relative");
    expect(g("Eosinophils", "EOSINOPHILS", "%")).toBe("Eosinophils, Relative");
    expect(g("Basophils", "BASOPHILS", "%")).toBe("Basophils, Relative");
  });

  it("leaves a unit-COMPATIBLE resolution untouched", () => {
    expect(g("Monocytes", "MONOCYTES", "cells/uL")).toBe("Monocytes");
    expect(g("Monocytes, Relative", "MONOCYTES", "%")).toBe(
      "Monocytes, Relative"
    );
    expect(g("Lymphocytes", "LYMPHOCYTES", "%")).toBe("Lymphocytes");
  });

  it("never fires without a provable contradiction (protects the urine-glucose case, §2)", () => {
    // Urine glucose is qualitative ("NEGATIVE") with no unit — nothing to contradict,
    // so the model's correct "Glucose, Urine" stands and the ambiguous printed
    // "GLUCOSE" is never snapped onto the serum entry.
    expect(g("Glucose, Urine", "GLUCOSE", null)).toBe("Glucose, Urine");
    expect(g("Glucose, Urine", "GLUCOSE", "")).toBe("Glucose, Urine");
    expect(seededUnitFor("Glucose, Urine")).toBeNull();
  });

  it("does not touch an ai-coined name (no seeded unit to judge)", () => {
    expect(g("Some Novel Analyte", "Some Novel Analyte", "mg/dL")).toBe(
      "Some Novel Analyte"
    );
  });

  it("falls through to the printed name ONLY when it lands on a compatible entry (§2)", () => {
    // No relative/absolute sibling for Hemoglobin, but the printed "Hematocrit" (%)
    // is unit-compatible with the reading, so it is the trustworthy target.
    expect(g("Hemoglobin", "Hematocrit", "%")).toBe("Hematocrit");
  });

  it("keeps the model's resolution when nothing better is unit-compatible", () => {
    // Incompatible, no sibling, and the printed name resolves to the same
    // incompatible entry: keep it rather than guess (surfaced separately, §4).
    expect(g("Hemoglobin", "Hemoglobin", "%")).toBe("Hemoglobin");
  });

  it("routes a bare WBC/RBC to the URINE entry when the unit is microscopy /HPF (#918)", () => {
    // "WBC"/"RBC" alias to the BLOOD count; a /HPF reading is urine sediment. The
    // blood and urine entries share no stem, so this rides the specimen-counterpart.
    expect(g("White Blood Cell Count", "WBC", "/HPF")).toBe(
      "White Blood Cells, Urine"
    );
    expect(g("Red Blood Cell Count", "RBC", "cell/HPF")).toBe(
      "Red Blood Cells, Urine"
    );
    // …but a blood-scale unit keeps the blood count.
    expect(g("White Blood Cell Count", "WBC", "10^3/uL")).toBe(
      "White Blood Cell Count"
    );
  });
});

describe("normalizeResults wires the unit guard", () => {
  it("relabels a %-united differential row onto the relative sibling end to end", () => {
    const out = normalizeResults(
      {
        results: [
          {
            category: "lab",
            name: "MONOCYTES",
            canonical_name: "Monocytes",
            value: "4.8",
            value_num: 4.8,
            unit: "%",
          },
        ],
      },
      vocab
    );
    expect(out).toHaveLength(1);
    expect(out[0].canonical_name).toBe("Monocytes, Relative");
  });
});
