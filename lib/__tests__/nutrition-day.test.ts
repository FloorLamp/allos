// PURE TIER — one day's protein + fibre position (#2379), the decision and its phrasing.
//
// What this pins, in the order the issue's acceptance states it:
//   1. the position is COMPOSED from the existing verdicts — no second adequacy rule;
//   2. a day that MET its targets emits nothing (the routine case is silence);
//   3. an unresolved target and an unlogged day both emit nothing, and are different
//      facts from a shortfall;
//   4. the shortfall carries the GAP and the floor classification, which is the shape
//      #2383 sizes a curated food suggestion from;
//   5. the demotion predicate reads that classification rather than inventing one;
//   6. the line is the #2391 grammar's parts — a head and N notes — so every separator in
//      the rendered text comes from `formatMessageLine` and none from this module.

import { describe, it, expect } from "vitest";
import {
  assessFiberAdequacy,
  fiberIntake,
  fiberTarget,
  type FiberAdequacy,
} from "@/lib/fiber";
import {
  assessProteinAdequacy,
  proteinIntake,
  proteinTarget,
  type ProteinAdequacy,
} from "@/lib/protein";
import {
  nutrientPositionPhrase,
  nutritionDayPosition,
  nutritionDigestLine,
  nutritionShortfalls,
  NUTRIENT_KEYS,
} from "@/lib/nutrition-day";
import { nutritionSurvivesDemotion } from "@/lib/notifications/digest-tune";
import { formatMessageLine } from "@/lib/notifications/message-line";

const DATE = "2026-08-08";

// The producer returns PARTS; this renders them exactly as the digest does, minus the
// glyph the Yesterday section stamps on. Every `—` and `·` below therefore comes from the
// shared formatter — which is the point of asserting the rendered text at all.
function rendered(
  pos: Parameters<typeof nutritionDigestLine>[0]
): string | null {
  const line = nutritionDigestLine(pos);
  return line ? formatMessageLine(line) : null;
}

// Built through the REAL engines, never a hand-written literal: a fixture that fabricates
// a `ProteinAdequacy` could pin a status the engine would never produce, and this module's
// whole claim is that it re-decides nothing.
function protein(opts: {
  estimated?: number;
  logged?: number;
  tracked?: number | null;
  bodyweightKg?: number | null;
}): ProteinAdequacy | null {
  return assessProteinAdequacy(
    proteinIntake({
      dailyTracked: opts.tracked ?? null,
      dailyLogged: opts.logged ?? null,
      dailyEstimated: opts.estimated ?? 0,
    }),
    proteinTarget({
      goal: "active", // 1.2–1.6 g/kg
      bodyweightKg: opts.bodyweightKg === undefined ? 80 : opts.bodyweightKg,
    })
  );
}

function fiber(opts: {
  estimated?: number;
  supplemented?: number;
  tracked?: number | null;
  unknownSupplement?: boolean;
  ageYears?: number | null;
}): FiberAdequacy | null {
  return assessFiberAdequacy(
    fiberIntake({
      dailyTracked: opts.tracked ?? null,
      dailyEstimated: opts.estimated ?? 0,
      dailySupplemented: opts.supplemented ?? null,
      unknownSupplement: opts.unknownSupplement ?? false,
    }),
    fiberTarget({
      ageYears: opts.ageYears === undefined ? 40 : opts.ageYears,
      sex: "male", // DRI adequate intake 38 g/day
    })
  );
}

describe("nutritionDayPosition — composing the two existing verdicts", () => {
  it("carries each nutrient's grams, target floor and the engine's own status", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      protein: protein({ estimated: 60 }),
      fiber: fiber({ estimated: 20 }),
    });
    expect(pos?.date).toBe(DATE);
    // 80 kg × 1.2 = 96, rounded to the nearest 5 by the engine.
    expect(pos?.protein).toMatchObject({
      nutrient: "protein",
      grams: 60,
      targetGrams: 95,
      status: "below",
      isFloor: true,
    });
    expect(pos?.fiber).toMatchObject({
      nutrient: "fiber",
      grams: 20,
      targetGrams: 38,
      status: "below",
    });
  });

  it("scores the protein band's FLOOR, not its ceiling — overshoot is not a shortfall", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      // 200 g is above the 95–130 g band's ceiling: `above`, and no gap to close.
      protein: protein({ tracked: 200 }),
      fiber: null,
    });
    expect(pos?.protein?.status).toBe("above");
    expect(pos?.protein?.shortfallGrams).toBe(0);
    expect(nutritionShortfalls(pos)).toEqual([]);
  });

  it("marks a tracked full-day total as measured, and every other basis as a floor", () => {
    const tracked = nutritionDayPosition({
      date: DATE,
      protein: protein({ tracked: 60 }),
      fiber: fiber({ tracked: 12 }),
    });
    expect(tracked?.protein?.isFloor).toBe(false);
    expect(tracked?.fiber?.isFloor).toBe(false);

    const floors = nutritionDayPosition({
      date: DATE,
      protein: protein({ estimated: 30, logged: 30 }), // `combined`
      fiber: fiber({ supplemented: 12 }), // `supplemented`
    });
    expect(floors?.protein?.isFloor).toBe(true);
    expect(floors?.fiber?.isFloor).toBe(true);
  });
});

describe("the absences — silence, never a zero", () => {
  it("is null when NEITHER nutrient can be positioned", () => {
    expect(
      nutritionDayPosition({ date: DATE, protein: null, fiber: null })
    ).toBeNull();
  });

  it("omits protein when no bodyweight resolves its target, keeping fibre", () => {
    // The unset-target case: `proteinTarget` refuses to scale a band by a mass it does
    // not have, so `assessProteinAdequacy` returns null and nothing is claimed.
    expect(protein({ estimated: 60, bodyweightKg: null })).toBeNull();
    const pos = nutritionDayPosition({
      date: DATE,
      protein: protein({ estimated: 60, bodyweightKg: null }),
      fiber: fiber({ estimated: 20 }),
    });
    expect(pos?.protein).toBeNull();
    expect(pos?.fiber).not.toBeNull();
    // …and the line names only the nutrient that HAS a target.
    expect(rendered(pos)).toBe("Nutrition — fiber 20 g+ of 38 g");
  });

  it("omits a nutrient whose day carries a signal but no NUMBER", () => {
    // A lone capsule fibre dose: the engine returns a verdict with 0 g and the honest
    // unknown-grams flag. "0 g of 38 g" would be a false claim about the day's eating.
    const unquantified = fiber({ unknownSupplement: true });
    expect(unquantified?.intake.grams).toBe(0);
    expect(
      nutritionDayPosition({ date: DATE, protein: null, fiber: unquantified })
    ).toBeNull();
  });

  it("says nothing about a day with nothing logged at all", () => {
    expect(protein({})).toBeNull();
    expect(fiber({})).toBeNull();
    expect(
      rendered(
        nutritionDayPosition({
          date: DATE,
          protein: protein({}),
          fiber: fiber({}),
        })
      )
    ).toBeNull();
  });
});

describe("when the line appears — and when it stays silent", () => {
  it("emits NOTHING on a day that met both targets", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      protein: protein({ tracked: 110 }), // within 95–130
      fiber: fiber({ tracked: 40 }), // within 38–61
    });
    expect(pos?.protein?.status).toBe("within");
    expect(pos?.fiber?.status).toBe("within");
    expect(nutritionShortfalls(pos)).toEqual([]);
    expect(nutritionDigestLine(pos)).toBeNull();
  });

  it("states only the SHORT nutrient when the other landed fine", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      protein: protein({ tracked: 110 }),
      fiber: fiber({ estimated: 18 }),
    });
    expect(rendered(pos)).toBe("Nutrition — fiber 18 g+ of 38 g");
  });

  it("shares ONE line when both fell short, in declared order", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      protein: protein({ estimated: 84 }),
      fiber: fiber({ estimated: 18 }),
    });
    // The head, then one note per short nutrient in NUTRIENT_KEYS order — the whole
    // line, with no separator of this module's own.
    expect(nutritionDigestLine(pos)).toEqual({
      head: "Nutrition",
      notes: ["protein 84 g+ of 95 g", "fiber 18 g+ of 38 g"],
    });
    expect(rendered(pos)).toBe(
      "Nutrition — protein 84 g+ of 95 g · fiber 18 g+ of 38 g"
    );
  });

  it("drops the floor marker for a measured total, which states its figure exactly", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      protein: protein({ tracked: 84 }),
      fiber: null,
    });
    expect(rendered(pos)).toBe("Nutrition — protein 84 g of 95 g");
  });

  it("names the number and stops — no obligation language", () => {
    const line =
      rendered(
        nutritionDayPosition({
          date: DATE,
          protein: protein({ estimated: 40 }),
          fiber: fiber({ estimated: 10 }),
        })
      ) ?? "";
    expect(line).not.toMatch(/missed|failed|should|need to|streak|behind/i);
  });
});

describe("the shortfall #2383 sizes a suggestion from", () => {
  it("carries the gap to the target floor, per nutrient", () => {
    const short = nutritionShortfalls(
      nutritionDayPosition({
        date: DATE,
        protein: protein({ tracked: 60 }),
        fiber: fiber({ tracked: 12 }),
      })
    );
    expect(short.map((s) => [s.nutrient, s.shortfallGrams])).toEqual([
      ["protein", 35], // 95 − 60
      ["fiber", 26], // 38 − 12
    ]);
  });

  it("agrees with the figures the copy prints, so a line can never contradict a gap", () => {
    const pos = nutritionDayPosition({
      date: DATE,
      // 40.4 g renders as "40 g"; the gap must be 95 − 40, not 95 − 40.4 rounded.
      protein: protein({ estimated: 40.4 }),
      fiber: null,
    });
    expect(nutrientPositionPhrase(pos!.protein!)).toBe("protein 40 g+ of 95 g");
    expect(pos?.protein?.shortfallGrams).toBe(55);
  });

  it("returns an empty list for a met day and for no position at all", () => {
    expect(nutritionShortfalls(null)).toEqual([]);
    expect(
      nutritionShortfalls(
        nutritionDayPosition({
          date: DATE,
          protein: protein({ tracked: 110 }),
          fiber: fiber({ tracked: 40 }),
        })
      )
    ).toEqual([]);
  });

  it("covers every modelled nutrient — a new key cannot be added without a label", () => {
    expect(NUTRIENT_KEYS).toEqual(["protein", "fiber"]);
  });
});

describe("nutritionSurvivesDemotion (#1714 applied to #2379)", () => {
  const floorShortfall = [{ isFloor: true }];
  const measuredShortfall = [{ isFloor: false }];

  it("keeps every shortfall while the category is on", () => {
    expect(nutritionSurvivesDemotion([], floorShortfall)).toBe(true);
    expect(nutritionSurvivesDemotion(["sleep"], floorShortfall)).toBe(true);
  });

  it("turns down the HEDGED shortfall — the one measured from a floor", () => {
    expect(nutritionSurvivesDemotion(["nutrition"], floorShortfall)).toBe(
      false
    );
  });

  it("keeps a shortfall measured from a tracked total, which is an asserted fact", () => {
    expect(nutritionSurvivesDemotion(["nutrition"], measuredShortfall)).toBe(
      true
    );
    // Mixed: one asserted shortfall is enough to keep the line.
    expect(
      nutritionSurvivesDemotion(
        ["nutrition"],
        [...floorShortfall, ...measuredShortfall]
      )
    ).toBe(true);
  });
});
