import { describe, it, expect } from "vitest";
import {
  estimatedFiberGrams,
  isFiberSupplement,
  fiberDoseGrams,
  fiberIntake,
  fiberTarget,
  assessFiberAdequacy,
  fiberIntakeSummary,
  fiberAdequacyDetail,
  fiberAdequacySignalKey,
  FIBER_ADEQUACY_PREFIX,
} from "@/lib/fiber";

// Pure-tier tests for the fiber-adequacy engine (issue #976): the #767 protein pipeline
// re-instantiated with a fourth (supplemented) basis. No DB/clock/network.

describe("estimatedFiberGrams", () => {
  it("sums servings × catalog fiber_g, skipping non-fiber and unknown slugs", () => {
    // legumes 8 g/serving × 2 = 16; whole_grains 3 × 1 = 3; poultry has no fiber_g (0);
    // an unknown slug contributes 0.
    expect(
      estimatedFiberGrams([
        { slug: "legumes", servings: 2 },
        { slug: "whole_grains", servings: 1 },
        { slug: "poultry", servings: 3 },
        { slug: "not_a_group", servings: 5 },
      ])
    ).toBe(19);
  });

  it("ignores zero/negative servings", () => {
    expect(
      estimatedFiberGrams([
        { slug: "legumes", servings: 0 },
        { slug: "berries", servings: -1 },
      ])
    ).toBe(0);
  });
});

describe("isFiberSupplement", () => {
  it("matches the common fiber products and brands", () => {
    for (const name of [
      "Psyllium Husk",
      "Metamucil",
      "Benefiber",
      "Methylcellulose",
      "Inulin powder",
      "Ground flaxseed",
      "Flax seed",
      "Fiber",
      "Generic Fiber supplement",
      "Wheat dextrin",
    ]) {
      expect(isFiberSupplement(name), name).toBe(true);
    }
  });

  it("does NOT match unrelated products (fish oil is not fiber)", () => {
    for (const name of [
      "Fish oil",
      "Omega-3 Fish Oil",
      "Vitamin D3",
      "Magnesium glycinate",
      "Creatine",
      "Whey protein",
    ]) {
      expect(isFiberSupplement(name), name).toBe(false);
    }
  });
});

describe("fiberDoseGrams", () => {
  it("parses gram amounts and rejects non-gram/unknown units (honestly unknown)", () => {
    expect(fiberDoseGrams("5 g")).toEqual({ grams: 5, known: true });
    expect(fiberDoseGrams("10 g")).toEqual({ grams: 10, known: true });
    expect(fiberDoseGrams("1.5 g")).toEqual({ grams: 1.5, known: true });
    // Non-gram / unknown → 0 g, known false.
    expect(fiberDoseGrams("1 capsule")).toEqual({ grams: 0, known: false });
    expect(fiberDoseGrams("2 scoops")).toEqual({ grams: 0, known: false });
    expect(fiberDoseGrams("500 mg")).toEqual({ grams: 0, known: false });
    expect(fiberDoseGrams(null)).toEqual({ grams: 0, known: false });
  });
});

describe("fiberIntake composition", () => {
  it("tracked reading OVERRIDES the estimated+supplemented sum", () => {
    const i = fiberIntake({
      dailyTracked: 30,
      dailyEstimated: 12,
      dailySupplemented: 5,
    });
    expect(i).toMatchObject({
      grams: 30,
      basis: "tracked",
      estimatedGrams: 0,
      supplementedGrams: 0,
      unknownSupplement: false,
    });
  });

  it("estimated + supplemented SUM to a combined basis", () => {
    const i = fiberIntake({
      dailyTracked: null,
      dailyEstimated: 12,
      dailySupplemented: 5,
    });
    expect(i).toMatchObject({
      grams: 17,
      basis: "combined",
      estimatedGrams: 12,
      supplementedGrams: 5,
    });
  });

  it("supplement-only → supplemented basis", () => {
    const i = fiberIntake({
      dailyTracked: null,
      dailyEstimated: 0,
      dailySupplemented: 5,
    });
    expect(i?.basis).toBe("supplemented");
    expect(i?.grams).toBe(5);
  });

  it("food-only → estimated basis", () => {
    const i = fiberIntake({ dailyTracked: null, dailyEstimated: 12 });
    expect(i?.basis).toBe("estimated");
    expect(i?.grams).toBe(12);
  });

  it("null when no basis has any signal", () => {
    expect(fiberIntake({ dailyTracked: null, dailyEstimated: 0 })).toBeNull();
  });

  it("an unknown-unit fiber dose (0 g) still surfaces, flagged, at supplemented basis", () => {
    const i = fiberIntake({
      dailyTracked: null,
      dailyEstimated: 0,
      dailySupplemented: 0,
      unknownSupplement: true,
    });
    expect(i).not.toBeNull();
    expect(i?.grams).toBe(0);
    expect(i?.unknownSupplement).toBe(true);
    expect(i?.basis).toBe("supplemented");
    // The summary notes the taken-but-unknown dose rather than fabricating a number.
    expect(fiberIntakeSummary(i!)).toMatch(/grams unknown/i);
  });
});

describe("fiberTarget DRI bands", () => {
  it("adult male 38 g, adult female 25 g (headline DRI)", () => {
    expect(fiberTarget({ ageYears: 30, sex: "male" })?.grams).toBe(38);
    expect(fiberTarget({ ageYears: 30, sex: "female" })?.grams).toBe(25);
  });

  it("drops to 30/21 at the 51+ boundary", () => {
    expect(fiberTarget({ ageYears: 50, sex: "male" })?.grams).toBe(38);
    expect(fiberTarget({ ageYears: 51, sex: "male" })?.grams).toBe(30);
    expect(fiberTarget({ ageYears: 51, sex: "female" })?.grams).toBe(21);
  });

  it("unknown sex uses the male/female midpoint for the band", () => {
    // adult 19–51: (38 + 25) / 2 = 31.5 → 32
    expect(fiberTarget({ ageYears: 30, sex: null })?.grams).toBe(32);
  });

  it("unknown age scores as an adult", () => {
    expect(fiberTarget({ ageYears: null, sex: "female" })?.grams).toBe(25);
  });

  it("null below the youngest band (infant)", () => {
    expect(fiberTarget({ ageYears: 0, sex: "male" })).toBeNull();
  });

  it("gramsHigh is a soft ceiling above the AI", () => {
    const t = fiberTarget({ ageYears: 30, sex: "male" })!;
    expect(t.gramsHigh).toBeGreaterThan(t.grams);
  });
});

describe("assessFiberAdequacy", () => {
  const target = fiberTarget({ ageYears: 30, sex: "male" })!; // 38, high ~61

  it("below the AI → below", () => {
    const i = fiberIntake({ dailyTracked: null, dailyEstimated: 20 })!;
    expect(assessFiberAdequacy(i, target)?.status).toBe("below");
  });

  it("at/above the AI within the ceiling → within", () => {
    const i = fiberIntake({ dailyTracked: 40, dailyEstimated: 0 })!;
    expect(assessFiberAdequacy(i, target)?.status).toBe("within");
  });

  it("above the soft ceiling → above", () => {
    const i = fiberIntake({ dailyTracked: 80, dailyEstimated: 0 })!;
    expect(assessFiberAdequacy(i, target)?.status).toBe("above");
  });

  it("null when intake or target missing", () => {
    expect(assessFiberAdequacy(null, target)).toBeNull();
    const i = fiberIntake({ dailyTracked: 20, dailyEstimated: 0 })!;
    expect(assessFiberAdequacy(i, null)).toBeNull();
  });
});

describe("fiber copy discipline", () => {
  it("a non-tracked below hedges the shortfall as a floor, never asserts a deficiency", () => {
    const target = fiberTarget({ ageYears: 30, sex: "male" })!;
    const i = fiberIntake({ dailyTracked: null, dailyEstimated: 15 })!;
    const detail = fiberAdequacyDetail(assessFiberAdequacy(i, target)!);
    expect(detail).toMatch(/floor/i);
    expect(detail).not.toMatch(/deficien/i);
    expect(detail).toMatch(/informational/i);
  });

  it("signal key is namespaced under the registered prefix", () => {
    expect(fiberAdequacySignalKey().startsWith(FIBER_ADEQUACY_PREFIX)).toBe(
      true
    );
  });
});
