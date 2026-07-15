import { describe, it, expect } from "vitest";
import {
  estimatedProteinGrams,
  proteinIntake,
  proteinTarget,
  assessProteinAdequacy,
  resolveProteinGoalLevel,
  proteinIntakeSummary,
  proteinTargetSummary,
  proteinAdequacyDetail,
  proteinAdequacySignalKey,
  PROTEIN_ADEQUACY_PREFIX,
} from "@/lib/protein";

// Pure engine tests for protein adequacy (#767): the three-basis intake pick, the
// goal-scaled target band (LBM-preferred), and the adequacy verdict + caveated wording.

describe("estimatedProteinGrams", () => {
  it("sums servings × the catalog per-serving grams, skipping non-bearing + unknown slugs", () => {
    const g = estimatedProteinGrams([
      { slug: "poultry", servings: 1 }, // 35
      { slug: "eggs", servings: 2 }, // 12 × 2 = 24
      { slug: "fruit", servings: 3 }, // non-bearing → 0
      { slug: "__retired__", servings: 5 }, // unknown → 0
    ]);
    expect(g).toBe(35 + 24);
  });

  it("ignores zero/negative servings", () => {
    expect(
      estimatedProteinGrams([
        { slug: "poultry", servings: 0 },
        { slug: "legumes", servings: -1 },
      ])
    ).toBe(0);
  });
});

describe("proteinIntake — source priority tracked > logged (reserved) > estimated", () => {
  it("prefers tracked when present", () => {
    expect(
      proteinIntake({ dailyTracked: 120, dailyLogged: 90, dailyEstimated: 60 })
    ).toEqual({ grams: 120, basis: "tracked" });
  });

  it("falls to logged when tracked is absent (reserved basis)", () => {
    expect(
      proteinIntake({ dailyTracked: null, dailyLogged: 90, dailyEstimated: 60 })
    ).toEqual({ grams: 90, basis: "logged" });
  });

  it("falls to the estimated floor when tracked + logged are absent", () => {
    expect(proteinIntake({ dailyTracked: null, dailyEstimated: 60 })).toEqual({
      grams: 60,
      basis: "estimated",
    });
  });

  it("returns null when no basis has any signal", () => {
    expect(proteinIntake({ dailyTracked: null, dailyEstimated: 0 })).toBeNull();
    expect(proteinIntake({ dailyTracked: 0, dailyEstimated: 0 })).toBeNull();
  });
});

describe("proteinTarget — goal bands + LBM-vs-total", () => {
  it("scales the general/active/hypertrophy/cut bands by total bodyweight", () => {
    const rda = proteinTarget({ goal: "rda", bodyweightKg: 80 });
    expect(rda).toMatchObject({
      gPerKgLow: 0.8,
      gPerKgHigh: 1.0,
      massBasis: "total",
      gramsLow: 65, // round5(64)
      gramsHigh: 80,
    });
    const active = proteinTarget({ goal: "active", bodyweightKg: 80 });
    expect(active).toMatchObject({ gramsLow: 95, gramsHigh: 130 }); // 96→95, 128→130
    const hyper = proteinTarget({ goal: "hypertrophy", bodyweightKg: 80 });
    expect(hyper).toMatchObject({ gramsLow: 130, gramsHigh: 175 }); // 128→130, 176→175
    const cut = proteinTarget({ goal: "cut", bodyweightKg: 80 });
    expect(cut).toMatchObject({ gramsLow: 160, gramsHigh: 190 }); // 160, 192→190
  });

  it("prefers lean mass when available — a smaller absolute target than g/kg-total", () => {
    // A higher-body-fat profile: 90 kg total, 60 kg lean. Same hypertrophy band.
    const byLean = proteinTarget({
      goal: "hypertrophy",
      bodyweightKg: 90,
      leanMassKg: 60,
    });
    const byTotal = proteinTarget({ goal: "hypertrophy", bodyweightKg: 90 });
    expect(byLean?.massBasis).toBe("lean");
    expect(byLean?.massKg).toBe(60);
    expect(byTotal?.massBasis).toBe("total");
    // LBM-referenced target is lower than g/kg-total for a high-BF person (the overshoot
    // correction #767 calls for).
    expect(byLean!.gramsHigh).toBeLessThan(byTotal!.gramsHigh);
  });

  it("ignores a non-positive lean mass and falls back to total", () => {
    const t = proteinTarget({
      goal: "active",
      bodyweightKg: 70,
      leanMassKg: 0,
    });
    expect(t?.massBasis).toBe("total");
    expect(t?.massKg).toBe(70);
  });

  it("returns null when there's no mass to scale by", () => {
    expect(proteinTarget({ goal: "active", bodyweightKg: null })).toBeNull();
    expect(
      proteinTarget({ goal: "active", bodyweightKg: null, leanMassKg: null })
    ).toBeNull();
  });
});

describe("resolveProteinGoalLevel", () => {
  it("maps known goal strings, defaulting unknown/empty to active", () => {
    expect(resolveProteinGoalLevel("bodybuilding")).toBe("hypertrophy");
    expect(resolveProteinGoalLevel("muscle_gain")).toBe("hypertrophy");
    expect(resolveProteinGoalLevel("cut")).toBe("cut");
    expect(resolveProteinGoalLevel("general")).toBe("rda");
    expect(resolveProteinGoalLevel(null)).toBe("active");
    expect(resolveProteinGoalLevel("")).toBe("active");
    expect(resolveProteinGoalLevel("something-else")).toBe("active");
  });
});

describe("assessProteinAdequacy + wording", () => {
  const target = proteinTarget({ goal: "active", bodyweightKg: 80 })!; // 95–130

  it("classifies below / within / above against the band", () => {
    expect(
      assessProteinAdequacy({ grams: 60, basis: "estimated" }, target)?.status
    ).toBe("below");
    expect(
      assessProteinAdequacy({ grams: 110, basis: "tracked" }, target)?.status
    ).toBe("within");
    expect(
      assessProteinAdequacy({ grams: 200, basis: "tracked" }, target)?.status
    ).toBe("above");
  });

  it("returns null when intake or target is missing", () => {
    expect(assessProteinAdequacy(null, target)).toBeNull();
    expect(
      assessProteinAdequacy({ grams: 60, basis: "estimated" }, null)
    ).toBeNull();
  });

  it("an estimated shortfall is framed as a FLOOR, never a definite deficiency", () => {
    const a = assessProteinAdequacy({ grams: 60, basis: "estimated" }, target)!;
    const detail = proteinAdequacyDetail(a);
    expect(detail).toMatch(/floor/i);
    expect(detail).not.toMatch(/deficien/i);
    expect(detail).toMatch(/informational/i);
    expect(proteinIntakeSummary(a.intake)).toMatch(/floor/i);
  });

  it("a tracked shortfall states the gap directly (no floor caveat)", () => {
    const a = assessProteinAdequacy({ grams: 60, basis: "tracked" }, target)!;
    expect(proteinIntakeSummary(a.intake)).not.toMatch(/floor/i);
    expect(proteinAdequacyDetail(a)).toMatch(/informational/i);
  });

  it("the target summary notes when the band is scaled to lean mass", () => {
    const leanTarget = proteinTarget({
      goal: "hypertrophy",
      bodyweightKg: 90,
      leanMassKg: 60,
    })!;
    expect(proteinTargetSummary(leanTarget)).toMatch(/lean mass/i);
  });
});

describe("proteinAdequacySignalKey", () => {
  it("is stable and namespaced under the registered prefix", () => {
    expect(proteinAdequacySignalKey().startsWith(PROTEIN_ADEQUACY_PREFIX)).toBe(
      true
    );
  });
});
