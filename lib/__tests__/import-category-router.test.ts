import { describe, expect, it } from "vitest";
import { normalizeResults } from "@/lib/medical-extract/normalize";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";

// #1076: the import router honors the canonical dataset's category. When an
// extracted reading resolves to a name in the controlled vocabulary, that entry's
// category WINS over the model's guess — so a re-homed analyte reaches its own
// surface, not /results/biomarkers. A name outside the vocabulary keeps the model's
// category. These are pure (no DB): normalizeResults over a synthetic tool payload.

function one(result: Record<string, unknown>) {
  const out = normalizeResults({ results: [result] });
  expect(out).toHaveLength(1);
  return out[0];
}

describe("import category router honors the canonical category (#1076)", () => {
  it("routes a screening instrument to `instrument` even when the model says `lab`", () => {
    // Sensitivity: a depression/alcohol score must NEVER file as a general lab.
    for (const name of ["PHQ-9", "GAD-7", "AUDIT-C", "AUDIT", "DAST-10"]) {
      const r = one({
        name,
        canonical_name: name,
        category: "lab",
        value: "12",
      });
      expect(r.category).toBe("instrument");
    }
  });

  it("routes an immutable fact to `reference`", () => {
    for (const name of ["Blood Type", "ABO Blood Group", "Rh Type"]) {
      const r = one({
        name,
        canonical_name: name,
        category: "lab",
        value: "O+",
      });
      expect(r.category).toBe("reference");
    }
  });

  it("routes a derived composite to `derived`", () => {
    for (const name of ["Biological Age", "PhenoAge"]) {
      const r = one({
        name,
        canonical_name: name,
        category: "lab",
        value_num: 42,
      });
      expect(r.category).toBe("derived");
    }
  });

  it("routes a physiologic vital to `vitals`, and glucose stays `lab`", () => {
    const temp = one({
      name: "Body Temperature",
      canonical_name: "Body Temperature",
      category: "lab",
      value_num: 101,
      unit: "degF",
    });
    expect(temp.category).toBe("vitals");
    const glucose = one({
      name: "Glucose",
      canonical_name: "Glucose",
      category: "vitals",
      value_num: 95,
      unit: "mg/dL",
    });
    expect(glucose.category).toBe("lab");
  });

  it("keeps the model's category for a name outside the vocabulary", () => {
    expect(canonicalBiomarkerForName("Totally Made Up Analyte")).toBeNull();
    const r = one({
      name: "Totally Made Up Analyte",
      canonical_name: "Totally Made Up Analyte",
      category: "lab",
      value_num: 1,
    });
    expect(r.category).toBe("lab");
  });
});
