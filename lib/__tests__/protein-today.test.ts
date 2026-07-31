import { describe, it, expect } from "vitest";
import {
  proteinIntake,
  proteinTarget,
  proteinTodayNudgeLine,
  proteinTodayNudgeParts,
  proteinTodayStatus,
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
    expect(line).toContain("Protein · 120 g");
    expect(line).not.toContain("at least");
  });

  // #1710: the line used to render "at least 107 g of ~80–105 g" with NO status —
  // 107 g is ABOVE the band, so the goal is reached, but the phrasing read like a
  // shortfall. The conclusion is stated in WORDS (not emoji alone) so it survives
  // screen readers and notification previews that strip emoji.
  it("states 'goal reached' at or above the band, and reads as reached — never a warning", () => {
    const above = proteinTodayNudgeLine(makeToday({ todayGrams: 140 }));
    expect(above).toContain("goal reached");
    expect(above).toContain("🎯");
    // Overshoot is not a problem, and there is no ceiling to have exceeded.
    expect(above.toLowerCase()).not.toMatch(/over|too much|exceed|max/);

    // Exactly at the band's floor is reached, not "below" — and the floor compared
    // against is the one the line PRINTS, so the words can't contradict the numbers.
    expect(proteinTodayNudgeLine(makeToday({ todayGrams: 95 }))).toContain(
      "goal reached"
    );
  });

  it("below the band is a NEUTRAL marker — no nag, no praise", () => {
    const below = proteinTodayNudgeLine(makeToday({ todayGrams: 62 }));
    expect(below).toContain("🍗");
    expect(below).not.toContain("goal reached");
    expect(below.toLowerCase()).not.toMatch(/short|need|should|behind|only/);
  });

  it("the status is ONE derivation, shared rather than re-decided per surface", () => {
    expect(proteinTodayStatus(makeToday({ todayGrams: 140 }))).toBe("reached");
    expect(proteinTodayStatus(makeToday({ todayGrams: 95 }))).toBe("reached");
    expect(proteinTodayStatus(makeToday({ todayGrams: 94 }))).toBe("below");
    // The parts and the joined line can't disagree.
    const t = makeToday({ todayGrams: 140 });
    const parts = proteinTodayNudgeParts(t);
    expect(proteinTodayNudgeLine(t)).toBe(
      `${parts.emoji} Protein · ${parts.amount} of ${parts.band} — ${parts.statusWords}`
    );
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
