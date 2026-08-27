import { describe, it, expect } from "vitest";
import {
  proteinGaugeMarker,
  proteinIntake,
  proteinTarget,
  proteinTodayExplanation,
  proteinTodayLineParts,
  proteinTodayStatus,
  type ProteinToday,
} from "@/lib/protein";
import { proteinNudgeLine } from "@/lib/notifications/food-format";

// The plain rendering moved to the module that serves the surface (#2391); the parts
// still come from lib/protein, so this stays a test of one conclusion rendered once.
const proteinTodayNudgeLine = (t: ProteinToday) =>
  proteinNudgeLine(proteinTodayLineParts(t));

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
    const parts = proteinTodayLineParts(t);
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
      makeToday({
        weeklyAverageGrams: 110,
        trailing: { grams: 95, dayOne: false },
      })
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
      makeToday({
        weeklyAverageGrams: null,
        trailing: { grams: 95, dayOne: false },
      })
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

// The dashboard's protein row and card (#3257). The owner's own line read
// "≥ 69 g · Goal ~80–105 g/day (1.2–1.6 g/kg, general fitness) · 7-day average
// 117 g/day · From logged foods + protein logged — a floor, actual likely higher".
// Four defects in one line: an inequality to parse, the band's derivation, two table
// names, and a hedge about the ESTIMATOR. The honesty the last clause carried is
// CORRECT for this profile and survives — as a sentence about the SITUATION, one tap
// away, while the glance line is a number and a goal.
describe("the dashboard protein line says the situation, not the estimator (#3257)", () => {
  // The one sentence that carries the floor, pinned as a LITERAL: it is the claim most
  // at risk of drifting back into something the data does not support, so a reword has
  // to show up here rather than sliding through a regex.
  const UNLOGGED =
    "Foods you haven't logged aren't counted, so your real total may be higher.";

  // Every state proteinTodayExplanation actually meets, and what is TRUE in each.
  // `none` is the state an established logger is in every morning until their first
  // entry (lib/queries/nutrition.ts returns todayIntake: null, todayGrams: 0), and it
  // is why #3257's dictated "Only some meals are logged" could not ship: there, and
  // for a `logged` basis, the number of meals logged is ZERO.
  //   label | proteinIntake args (null = nothing logged) | amount | source clause | floor?
  const STATES = [
    [
      "combined",
      { dailyTracked: null, dailyLogged: 30, dailyEstimated: 25 },
      "55 g+",
      "Today's total is from foods and logged protein.",
      true,
    ],
    [
      "estimated",
      { dailyTracked: null, dailyEstimated: 40 },
      "40 g+",
      "Today's total is from your food log.",
      true,
    ],
    [
      "logged",
      { dailyTracked: null, dailyLogged: 45, dailyEstimated: 0 },
      "45 g+",
      "Today's total is from the protein you logged.",
      true,
    ],
    [
      "tracked",
      { dailyTracked: 120, dailyEstimated: 0 },
      "120 g",
      "Today's total is from the daily total your health app sends.",
      false,
    ],
    ["none", null, "0 g+", null, false],
  ] as const;

  it.each(STATES)(
    "%s: a plain figure on the row, and only true statements in the hover",
    (label, args, amount, sourceClause, floorSentence) => {
      const todayIntake = args ? proteinIntake(args)! : null;
      if (todayIntake) expect(todayIntake.basis).toBe(label);
      const t = makeToday({
        todayIntake,
        todayGrams: todayIntake?.grams ?? 0,
      });
      const parts = proteinTodayLineParts(t);

      // THE GLANCE, exactly as the row composes it: value plus "Goal <band>". The
      // floor rides on one character, the same "+" Telegram has used since #1822.
      expect(parts.amount).toBe(amount);
      expect(parts.band).toBe("95–130 g");
      expect(`${parts.amount} · Goal ${parts.band}`).not.toMatch(
        /≥|g\/kg|\(|floor|likely/
      );

      // THE HOVER carries the derivation the row stopped carrying, and nothing that
      // counts meals — the retracted sentence must not reappear in any state.
      const hover = proteinTodayExplanation(t);
      expect(hover).toContain("1.2–1.6 g/kg");
      expect(hover).not.toMatch(/floor|likely higher|≥|meals are logged/);

      // The source is named only when there IS one.
      if (sourceClause) expect(hover).toContain(sourceClause);
      else expect(hover).not.toContain("Today's total is");

      // …and the floor sentence appears in exactly the states where it is true.
      expect(hover.includes(UNLOGGED)).toBe(floorSentence);
    }
  );

  it("reaches no adequacy verdict — that is proteinAdequacyTitle's question (#221)", () => {
    // Far under the band and far over it, on a real floor basis, the explanation is
    // the SAME sentence: the row reports, the adequacy computation judges, and
    // neither does the other's job.
    const floorBasis = proteinIntake({
      dailyTracked: null,
      dailyEstimated: 20,
    })!;
    const under = proteinTodayExplanation(
      makeToday({ todayIntake: floorBasis, todayGrams: 20 })
    );
    const over = proteinTodayExplanation(
      makeToday({ todayIntake: floorBasis, todayGrams: 200 })
    );
    expect(under).toBe(over);
    expect(under).not.toMatch(
      /below|above|short of|within|goal reached|enough/i
    );
  });
});
