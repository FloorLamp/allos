import { describe, it, expect } from "vitest";
import {
  CONDITION_NUTRIENT_RULES,
  conditionsContraindicatingNutrient,
} from "@/lib/condition-nutrient";

// Pure-tier tests for the shared condition→nutrient contraindication rules (#657),
// derived from the SAME curated nutrient-food-map the food engine hard-drops on.

describe("CONDITION_NUTRIENT_RULES", () => {
  it("derives the CKD × potassium/magnesium drop rules from the map", () => {
    const byNutrient = new Map<string, typeof CONDITION_NUTRIENT_RULES>();
    for (const r of CONDITION_NUTRIENT_RULES) {
      byNutrient.set(r.nutrientKey, [
        ...(byNutrient.get(r.nutrientKey) ?? []),
        r,
      ]);
    }
    expect([...byNutrient.keys()].sort()).toContain("potassium");
    expect([...byNutrient.keys()].sort()).toContain("magnesium");

    const mag = byNutrient.get("magnesium")!;
    expect(mag.some((r) => r.match.includes("chronic kidney"))).toBe(true);
    expect(mag.every((r) => r.nutrientTokens.includes("magnesium"))).toBe(true);
  });

  it("only carries drop-severity rules (caution-only map tags are excluded)", () => {
    // omega-3's pregnancy contraindication is a "caution", not a "drop" — it must not
    // leak into the belt/UL-caveat rules.
    expect(
      CONDITION_NUTRIENT_RULES.some((r) => r.nutrientKey === "omega-3")
    ).toBe(false);
  });
});

describe("conditionsContraindicatingNutrient", () => {
  it("matches an active condition substring for the nutrient key", () => {
    const hits = conditionsContraindicatingNutrient("magnesium", [
      "Chronic kidney disease, stage 3",
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].condition).toBe("Chronic kidney disease, stage 3");
    expect(hits[0].caution.toLowerCase()).toContain("kidney");
  });

  it("is empty for a nutrient with no drop rule or an unrelated condition", () => {
    expect(
      conditionsContraindicatingNutrient("magnesium", ["hypertension"])
    ).toEqual([]);
    expect(
      conditionsContraindicatingNutrient("vitamin_d", [
        "chronic kidney disease",
      ])
    ).toEqual([]);
  });
});
