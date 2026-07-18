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

describe("proteinIntake — tracked OVERRIDES, else estimated + logged SUM (#824)", () => {
  it("tracked (a measured full-day total) overrides the sum", () => {
    expect(
      proteinIntake({ dailyTracked: 120, dailyLogged: 90, dailyEstimated: 60 })
    ).toEqual({
      grams: 120,
      basis: "tracked",
      estimatedGrams: 0,
      loggedGrams: 0,
    });
  });

  it("SUMS the estimated floor + logged grams — a manual entry is a partial addition, never an eraser", () => {
    // The load-bearing #824 semantic: 90 g estimated + 30 g logged = 120 g, not 30.
    expect(
      proteinIntake({ dailyTracked: null, dailyLogged: 30, dailyEstimated: 90 })
    ).toEqual({
      grams: 120,
      basis: "combined",
      estimatedGrams: 90,
      loggedGrams: 30,
    });
  });

  it("is `logged` when only manual grams are present (no protein-bearing foods)", () => {
    expect(
      proteinIntake({ dailyTracked: null, dailyLogged: 40, dailyEstimated: 0 })
    ).toEqual({
      grams: 40,
      basis: "logged",
      estimatedGrams: 0,
      loggedGrams: 40,
    });
  });

  it("is `estimated` when only the food-group floor is present (no manual grams)", () => {
    expect(proteinIntake({ dailyTracked: null, dailyEstimated: 60 })).toEqual({
      grams: 60,
      basis: "estimated",
      estimatedGrams: 60,
      loggedGrams: 0,
    });
    // A null/absent dailyLogged is treated as zero, not an error.
    expect(
      proteinIntake({
        dailyTracked: null,
        dailyLogged: null,
        dailyEstimated: 60,
      })
    ).toMatchObject({ grams: 60, basis: "estimated" });
  });

  it("returns null when no basis has any signal", () => {
    expect(proteinIntake({ dailyTracked: null, dailyEstimated: 0 })).toBeNull();
    expect(proteinIntake({ dailyTracked: 0, dailyEstimated: 0 })).toBeNull();
    expect(
      proteinIntake({ dailyTracked: null, dailyLogged: 0, dailyEstimated: 0 })
    ).toBeNull();
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

// Intake literal builders so the assessment tests read cleanly (the interface carries the
// estimated/logged composition parts now, #824).
const estimated = (grams: number) => ({
  grams,
  basis: "estimated" as const,
  estimatedGrams: grams,
  loggedGrams: 0,
});
const tracked = (grams: number) => ({
  grams,
  basis: "tracked" as const,
  estimatedGrams: 0,
  loggedGrams: 0,
});
const combined = (est: number, logged: number) => ({
  grams: est + logged,
  basis: "combined" as const,
  estimatedGrams: est,
  loggedGrams: logged,
});
const loggedOnly = (grams: number) => ({
  grams,
  basis: "logged" as const,
  estimatedGrams: 0,
  loggedGrams: grams,
});

describe("assessProteinAdequacy + wording", () => {
  const target = proteinTarget({ goal: "active", bodyweightKg: 80 })!; // 95–130

  it("classifies below / within / above against the band", () => {
    expect(assessProteinAdequacy(estimated(60), target)?.status).toBe("below");
    expect(assessProteinAdequacy(tracked(110), target)?.status).toBe("within");
    expect(assessProteinAdequacy(tracked(200), target)?.status).toBe("above");
  });

  it("returns null when intake or target is missing", () => {
    expect(assessProteinAdequacy(null, target)).toBeNull();
    expect(assessProteinAdequacy(estimated(60), null)).toBeNull();
  });

  it("an estimated shortfall is framed as a FLOOR, never a definite deficiency", () => {
    const a = assessProteinAdequacy(estimated(60), target)!;
    const detail = proteinAdequacyDetail(a);
    expect(detail).toMatch(/floor/i);
    expect(detail).not.toMatch(/deficien/i);
    expect(detail).toMatch(/informational/i);
    expect(proteinIntakeSummary(a.intake)).toMatch(/floor/i);
  });

  it("a tracked shortfall states the gap directly (no floor caveat)", () => {
    const a = assessProteinAdequacy(tracked(60), target)!;
    expect(proteinIntakeSummary(a.intake)).not.toMatch(/floor/i);
    expect(proteinAdequacyDetail(a)).toMatch(/informational/i);
  });

  it("a combined shortfall is ALSO framed as a floor (the sum stays a floor)", () => {
    const a = assessProteinAdequacy(combined(50, 20), target)!; // 70 < 95
    expect(proteinIntakeSummary(a.intake)).toMatch(/floor/i);
    expect(proteinAdequacyDetail(a)).toMatch(/floor/i);
    expect(proteinAdequacyDetail(a)).not.toMatch(/deficien/i);
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

describe("proteinIntakeSummary — the honest per-basis display labels (#824)", () => {
  it("names the combined composition honestly (estimated + logged, floor-caveated)", () => {
    const s = proteinIntakeSummary(combined(90, 30));
    expect(s).toContain("120 g");
    expect(s).toMatch(/90 g estimated from foods/);
    expect(s).toMatch(/30 g logged/);
    expect(s).toMatch(/floor/i);
  });

  it("labels a logged-only intake as logged, still a floor", () => {
    const s = proteinIntakeSummary(loggedOnly(40));
    expect(s).toContain("40 g");
    expect(s).toMatch(/logged/i);
    expect(s).toMatch(/floor/i);
  });

  it("labels an estimated-only intake from logged foods, a floor", () => {
    const s = proteinIntakeSummary(estimated(80));
    expect(s).toMatch(/logged foods/i);
    expect(s).toMatch(/floor/i);
  });

  it("a tracked intake reads as a measured total (no floor caveat)", () => {
    const s = proteinIntakeSummary(tracked(140));
    expect(s).toContain("140 g");
    expect(s).toMatch(/tracked/i);
    expect(s).not.toMatch(/floor/i);
  });
});

describe("proteinAdequacySignalKey", () => {
  it("is stable and namespaced under the registered prefix", () => {
    expect(proteinAdequacySignalKey().startsWith(PROTEIN_ADEQUACY_PREFIX)).toBe(
      true
    );
  });
});
