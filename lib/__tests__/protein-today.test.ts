import { describe, it, expect } from "vitest";
import {
  proteinIntake,
  proteinTarget,
  proteinTodayNudgeLine,
  type ProteinToday,
} from "@/lib/protein";

// Pure-tier tests for the #974 protein band gauge model + food-nudge status line. The
// gather (getProteinToday) is DB-tier-tested; here we pin the pure formatters and the
// composition invariants. No DB/clock.

const target = proteinTarget({
  goal: "active",
  bodyweightKg: 80,
  leanMassKg: null,
})!; // active 1.2–1.6 g/kg × 80 = 96–128

function makeToday(over: Partial<ProteinToday>): ProteinToday {
  return {
    todayIntake: null,
    todayGrams: 0,
    target,
    weeklyAverageGrams: null,
    ...over,
  };
}

describe("proteinTodayNudgeLine", () => {
  it("a floor basis (estimated + logged) reads 'at least N g'", () => {
    const todayIntake = proteinIntake({
      dailyTracked: null,
      dailyLogged: 30,
      dailyEstimated: 25,
    })!; // basis combined, 55 g
    const line = proteinTodayNudgeLine(
      makeToday({ todayIntake, todayGrams: todayIntake.grams })
    );
    expect(line).toContain("at least 55 g");
    expect(line).toContain("of ~95–130 g"); // rounded band (96→95, 128→130)
  });

  it("a tracked reading states the figure directly (no 'at least')", () => {
    const todayIntake = proteinIntake({
      dailyTracked: 120,
      dailyEstimated: 0,
    })!;
    const line = proteinTodayNudgeLine(
      makeToday({ todayIntake, todayGrams: todayIntake.grams })
    );
    expect(line).toContain("Protein today · 120 g");
    expect(line).not.toContain("at least");
  });

  it("no today data yet reads 'at least 0 g' (a floor, in progress)", () => {
    const line = proteinTodayNudgeLine(
      makeToday({ todayIntake: null, todayGrams: 0, weeklyAverageGrams: 95 })
    );
    expect(line).toContain("at least 0 g");
  });
});

describe("gauge/nudge share one figure (#221)", () => {
  it("the nudge line's today figure is exactly todayGrams", () => {
    const todayIntake = proteinIntake({
      dailyTracked: null,
      dailyLogged: 42,
      dailyEstimated: 0,
    })!;
    const t = makeToday({ todayIntake, todayGrams: todayIntake.grams });
    // Both the gauge (reads t.todayGrams) and the nudge line render the same number.
    expect(t.todayGrams).toBe(42);
    expect(proteinTodayNudgeLine(t)).toContain("42 g");
  });
});
