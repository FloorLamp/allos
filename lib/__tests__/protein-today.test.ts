import { describe, it, expect } from "vitest";
import {
  proteinGaugeMarker,
  proteinIntake,
  proteinTarget,
  proteinTodayNudgeParts,
  proteinTodayStatus,
  type ProteinToday,
} from "@/lib/protein";
import { proteinNudgeLine } from "@/lib/notifications/food-format";

// The plain rendering moved to the module that serves the surface (#2391); the parts
// still come from lib/protein, so this stays a test of one conclusion rendered once.
const proteinTodayNudgeLine = (t: ProteinToday) =>
  proteinNudgeLine(proteinTodayNudgeParts(t));

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
    trailing: { grams: null, dayOne: false },
    ...over,
  };
}

describe("proteinTodayNudgeLine", () => {
  it("a floor basis (estimated + logged) marks the floor with a trailing '+'", () => {
    const todayIntake = proteinIntake({
      dailyTracked: null,
      dailyLogged: 30,
      dailyEstimated: 25,
    })!; // basis combined, 55 g
    const line = proteinTodayNudgeLine(
      makeToday({ todayIntake, todayGrams: todayIntake.grams })
    );
    // #1822 item 4: the floor marker survives (#767) but stops stacking hedges —
    // "at least 55 g of ~95–130 g" became "55 g+ so far · goal 95–130 g".
    expect(line).toBe("🍗 Protein: 55 g+ so far — goal 95–130 g"); // rounded band (96→95, 128→130)
    expect(line).not.toContain("at least");
  });

  it("a tracked reading states the figure directly (no floor marker)", () => {
    const todayIntake = proteinIntake({
      dailyTracked: 120,
      dailyEstimated: 0,
    })!;
    const line = proteinTodayNudgeLine(
      makeToday({ todayIntake, todayGrams: todayIntake.grams })
    );
    expect(line).toContain("Protein: 120 g so far");
    expect(line).not.toContain("120 g+");
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
    // The em dash introduces the FIRST qualifier the line has and `·` separates the
    // rest (#2391) — the same grammar every other system-initiated line uses.
    expect(proteinTodayNudgeLine(t)).toBe(
      `${parts.emoji} Protein: ${parts.amount} so far — goal ${parts.band} · ${parts.statusWords}`
    );
  });

  it("no today data yet reads '0 g+ so far' (a floor, in progress)", () => {
    const line = proteinTodayNudgeLine(
      makeToday({ todayIntake: null, todayGrams: 0, weeklyAverageGrams: 95 })
    );
    expect(line).toContain("0 g+ so far");
  });

  // #1822 item 4 is ARRANGEMENT, not semantics: every fact the pre-#1822 line carried
  // is still carried, and the below-band tone contract (#1710/#992) is untouched.
  it("carries the identical facts in one pass — floor marker, band, no nag", () => {
    const below = proteinTodayNudgeLine(makeToday({ todayGrams: 36 }));
    expect(below).toBe("🍗 Protein: 36 g+ so far — goal 95–130 g");
    // The three stacked hedges are gone: no "at least", no "of", no "~".
    expect(below).not.toMatch(/at least|~| of /);
    // Still neutral below the band — a marker, not a nag.
    expect(below).not.toContain("goal reached");
    expect(below.toLowerCase()).not.toMatch(/short|need|should|behind|only/);
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

// ---- The gauge's average marker (#2328) -----------------------------------
//
// One decision, in the model: WHICH average the gauge's single marker line holds,
// and therefore what it may be called. The renderer only prints what it is handed.
describe("proteinGaugeMarker (#2328)", () => {
  it("prefers this week's average and labels it as the week's", () => {
    const m = proteinGaugeMarker(
      makeToday({ weeklyAverageGrams: 110, trailing: { grams: 95, dayOne: false } })
    );
    expect(m).toEqual({
      kind: "week-to-date",
      grams: 110,
      label: "This week",
      ariaPhrase: "this week 110 grams a day",
    });
  });

  it("falls back to the trailing average when the week has no figure yet", () => {
    // A week-start morning for an established logger: nothing logged today, so the
    // week-to-date window is empty — but the trailing seven days are not, and that
    // is a true thing the gauge can say instead of standing empty.
    const m = proteinGaugeMarker(
      makeToday({ weeklyAverageGrams: null, trailing: { grams: 95, dayOne: false } })
    );
    expect(m?.kind).toBe("trailing");
    expect(m?.grams).toBe(95);
    // #1917's rule survives the fallback: the trailing figure never wears the
    // week's label, and the week's figure never wears "7-day".
    expect(m?.label).toBe("7-day avg");
    expect(m?.ariaPhrase).toContain("7-day average");
  });

  it("never borrows the other window's label", () => {
    const week = proteinGaugeMarker(makeToday({ weeklyAverageGrams: 110 }));
    const trailing = proteinGaugeMarker(
      makeToday({ trailing: { grams: 95, dayOne: false } })
    );
    expect(week!.label).not.toContain("7-day");
    expect(trailing!.label).not.toMatch(/week/i);
  });

  it("declines a day-one trailing figure — that number is today's own bar", () => {
    // `dayOne` means the helper handed back TODAY's intake for want of any complete
    // day. The gauge already draws today; marking it against itself says nothing.
    expect(
      proteinGaugeMarker(makeToday({ trailing: { grams: 84, dayOne: true } }))
    ).toBeNull();
  });

  it("no marker at all when neither window holds a figure", () => {
    expect(proteinGaugeMarker(makeToday({}))).toBeNull();
  });
});
