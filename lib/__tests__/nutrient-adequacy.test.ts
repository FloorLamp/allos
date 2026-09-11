import { describe, it, expect } from "vitest";
import {
  TODAY_PERIOD,
  aggregatePeriod,
  composeNutrientIntake,
  dayPeriod,
  estimatedNutrientGrams,
  nutrientAdequacyStatus,
  type NutrientDeclaration,
  type NutrientPeriod,
} from "@/lib/nutrient-adequacy";

// The shared nutrient-adequacy substrate (#4485): the precedence, the winning source,
// and the period-aware floor, computed ONCE with the figure they describe. The
// per-nutrient adapters over it are covered by protein.test.ts / fiber.test.ts; this
// file covers the decisions those two used to spell separately.

const NUT: NutrientDeclaration<"tracked" | "estimated" | "supplemented"> = {
  nutrient: "test-nutrient",
  precedence: "larger-wins",
  goalShape: "floor",
  column: "fiber_g",
  sources: { tracked: "tracked", estimated: "in-app", supplemented: "in-app" },
};

const compose = (
  grams: {
    tracked?: number | null;
    estimated?: number | null;
    supplemented?: number | null;
  },
  period: NutrientPeriod,
  unquantified = false
) =>
  composeNutrientIntake(NUT, {
    grams: {
      tracked: grams.tracked ?? null,
      estimated: grams.estimated ?? null,
      supplemented: grams.supplemented ?? null,
    },
    unquantified,
    period,
  });

const PAST_DAY = dayPeriod("2026-09-04", "2026-09-11");

describe("larger-wins — the RULED precedence, encoded (#3903, generalised by #4127)", () => {
  it("takes the max of the two sides, never their sum", () => {
    // A sum would double-count a shake entered in both places; an override would
    // discard the profile's own logging. Both were rejected by the ruling.
    const i = compose(
      { tracked: 200, estimated: 90, supplemented: 30 },
      TODAY_PERIOD
    )!;
    expect(i.trackedGrams).toBe(200);
    expect(i.inAppGrams).toBe(120); // the in-app components DO sum
    expect(i.grams).toBe(200); // …and the two SIDES do not: never 320
    expect(
      compose({ tracked: 100, estimated: 90, supplemented: 40 }, TODAY_PERIOD)!
        .grams
    ).toBe(130);
  });

  it("connecting an integration can never LOWER the figure", () => {
    // The property #3903 exists to guarantee, over the whole grid rather than a case.
    for (const estimated of [0, 20, 90]) {
      for (const supplemented of [0, 5, 40]) {
        const without = compose({ estimated, supplemented }, TODAY_PERIOD);
        for (const tracked of [1, 30, 200]) {
          const with_ = compose(
            { tracked, estimated, supplemented },
            TODAY_PERIOD
          )!;
          expect(with_.grams).toBeGreaterThanOrEqual(without?.grams ?? 0);
        }
      }
    }
  });

  it("names the winning source, with a tie going to the measured reading", () => {
    expect(compose({ tracked: 120, estimated: 90 }, TODAY_PERIOD)!.winner).toBe(
      "tracked"
    );
    expect(compose({ tracked: 60, estimated: 90 }, TODAY_PERIOD)!.winner).toBe(
      "in-app"
    );
    expect(compose({ tracked: 90, estimated: 90 }, TODAY_PERIOD)!.winner).toBe(
      "tracked"
    );
    expect(compose({ estimated: 90 }, TODAY_PERIOD)!.winner).toBe("in-app");
  });

  it("keeps every declared contribution visible even when the other side won", () => {
    // A surface must be able to say "you logged 30 g" on a day the integration's
    // reading is the figure — the contributions are the ledger, not a decomposition.
    const i = compose(
      { tracked: 200, estimated: 90, supplemented: 30 },
      TODAY_PERIOD
    )!;
    expect(i.contributions).toEqual({
      tracked: 200,
      estimated: 90,
      supplemented: 30,
    });
    expect(i.grams).toBe(200);
  });

  it("clamps missing and negative readings to zero rather than subtracting them", () => {
    const i = compose(
      { tracked: -5, estimated: 20, supplemented: null },
      TODAY_PERIOD
    )!;
    expect(i.contributions).toEqual({
      tracked: 0,
      estimated: 20,
      supplemented: 0,
    });
    expect(i.grams).toBe(20);
  });

  it("returns null only when no source has signal and nothing was unquantifiable", () => {
    expect(compose({}, TODAY_PERIOD)).toBeNull();
    expect(compose({ tracked: 0, estimated: 0 }, TODAY_PERIOD)).toBeNull();
    // #4155: a lone capsule dose still surfaces at 0 g so its note can render.
    const lone = compose({}, TODAY_PERIOD, true)!;
    expect(lone.grams).toBe(0);
    expect(lone.unquantified).toBe(true);
  });
});

describe("the floor needs the period AND the winner, not either alone (#4145)", () => {
  it("hedges a tracked-only TODAY — the reading is a running partial", () => {
    // The defect `basis !== "tracked"` produced: an integration writes one sample per
    // meal as it syncs, so at 09:00 the figure is breakfast, not the day.
    const i = compose({ tracked: 120 }, TODAY_PERIOD)!;
    expect(i.floor).toMatchObject({ isFloor: true, reasons: ["unsent-meals"] });
  });

  it("does NOT hedge a tracked-only COMPLETED day — that reading is the whole day", () => {
    expect(compose({ tracked: 120 }, PAST_DAY)!.floor).toMatchObject({
      isFloor: false,
      reasons: [],
    });
  });

  it("does NOT hedge a completed day whose tracked reading WON the max", () => {
    // The other half of #4145: knowing the day is complete is not enough, because on a
    // mixed-source day the answer turns on which side of the max() won. Here the
    // measured full-day total won, so the food log's incompleteness cannot make it a
    // floor — the old `basis === "both-sources"` test said it did.
    const i = compose(
      { tracked: 200, estimated: 90, supplemented: 30 },
      PAST_DAY
    )!;
    expect(i.winner).toBe("tracked");
    expect(i.floor).toMatchObject({ isFloor: false, reasons: [] });
  });

  it("DOES hedge a completed day whose in-app ledger won — untracked foods stay invisible", () => {
    const i = compose(
      { tracked: 60, estimated: 90, supplemented: 30 },
      PAST_DAY
    )!;
    expect(i.winner).toBe("in-app");
    expect(i.floor).toMatchObject({
      isFloor: true,
      reasons: ["in-app-ledger"],
    });
  });

  it("carries BOTH reasons on a mixed-source today, whichever side won", () => {
    // Both ledgers are open while the day runs, so both sentences are true at once.
    for (const tracked of [200, 60]) {
      expect(
        compose({ tracked, estimated: 90, supplemented: 30 }, TODAY_PERIOD)!
          .floor.reasons
      ).toEqual(["in-app-ledger", "unsent-meals"]);
    }
  });

  it("hedges an unquantified dose on EVERY basis and period (#4155)", () => {
    for (const period of [TODAY_PERIOD, PAST_DAY, aggregatePeriod(7, false)]) {
      const i = compose({ tracked: 200, estimated: 0 }, period, true)!;
      expect(i.floor.reasons).toContain("unquantified-dose");
      expect(i.floor.isFloor).toBe(true);
    }
  });
});

describe("a week is not a day-complete boolean (#4145's weekly-average comment)", () => {
  it("marks a window that still holds today as in progress, without calling it a floor", () => {
    // Today is one seventh of the window, so the running-partial hedge a single day
    // earns does not transfer to the mean — it gets its own, weaker statement.
    const i = compose({ tracked: 120 }, aggregatePeriod(7, true))!;
    expect(i.floor).toEqual({
      isFloor: false,
      reasons: [],
      windowInProgress: true,
    });
  });

  it("says nothing extra about a window of completed days", () => {
    expect(compose({ tracked: 120 }, aggregatePeriod(7, false))!.floor).toEqual(
      {
        isFloor: false,
        reasons: [],
        windowInProgress: false,
      }
    );
  });

  it("still hedges a week the app's own ledger carried", () => {
    const i = compose({ estimated: 90 }, aggregatePeriod(7, true))!;
    expect(i.floor).toEqual({
      isFloor: true,
      reasons: ["in-app-ledger"],
      windowInProgress: true,
    });
  });

  it("carries the period it was composed for, so no surface re-decides it", () => {
    expect(
      compose({ estimated: 90 }, aggregatePeriod(3, true))!.period
    ).toEqual({
      kind: "aggregate",
      days: 3,
      includesToday: true,
    });
  });
});

describe("dayPeriod", () => {
  it("calls the profile's own today accumulating and any earlier day complete", () => {
    expect(dayPeriod("2026-09-11", "2026-09-11")).toEqual({ kind: "today" });
    expect(dayPeriod("2026-09-10", "2026-09-11")).toEqual({ kind: "past-day" });
    // A date past today cannot be more complete than today.
    expect(dayPeriod("2026-09-12", "2026-09-11")).toEqual({ kind: "today" });
  });
});

describe("the declared goal shape is the only comparison", () => {
  it("scores below / within / above against the band it is given", () => {
    expect(nutrientAdequacyStatus(60, { low: 95, high: 130 })).toBe("below");
    expect(nutrientAdequacyStatus(95, { low: 95, high: 130 })).toBe("within");
    expect(nutrientAdequacyStatus(131, { low: 95, high: 130 })).toBe("above");
  });
});

describe("estimatedNutrientGrams — one rollup sum, two catalog columns", () => {
  // The catalog figures each nutrient's floor is summed from. Both columns are pinned
  // here because the loop is now shared: a column read for the wrong nutrient would
  // otherwise only show up as a wrong gram figure somewhere downstream.
  it.each([
    [
      "protein_g",
      [
        { slug: "poultry", servings: 1 }, // 35
        { slug: "eggs", servings: 2 }, // 12 × 2 = 24
        { slug: "fruit", servings: 3 }, // non-bearing → 0
        { slug: "__retired__", servings: 5 }, // unknown slug → 0
      ],
      35 + 24,
    ],
    [
      "fiber_g",
      [
        { slug: "legumes", servings: 2 }, // 8 × 2 = 16
        { slug: "whole_grains", servings: 1 }, // 3
        { slug: "poultry", servings: 3 }, // no fiber_g → 0
        { slug: "not_a_group", servings: 5 }, // unknown slug → 0
      ],
      19,
    ],
  ] as const)(
    "sums the %s column, skipping non-bearing and unknown slugs",
    (column, servings, expected) => {
      expect(estimatedNutrientGrams(servings, column)).toBe(expected);
    }
  );

  it("ignores zero and negative servings", () => {
    expect(
      estimatedNutrientGrams(
        [
          { slug: "poultry", servings: 0 },
          { slug: "legumes", servings: -1 },
        ],
        "protein_g"
      )
    ).toBe(0);
  });
});
