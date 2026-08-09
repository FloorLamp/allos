// PURE TIER — the food-regularity measure and the offer it licenses (#2380).
// No DB, no clock: every case states its own `today` and its own already-derived
// windows, so the arithmetic is reproducible from the same rows forever.

import { describe, expect, it } from "vitest";
import {
  FOOD_REGULARITY_HABITUAL_SHARE,
  FOOD_REGULARITY_MIN_WINDOW_DAYS,
  FOOD_REGULARITY_SPAN_DAYS,
  FOOD_USUAL_MIN_GROUPS,
  foodRegularity,
  habitualFoodGroups,
  usualFoodOffer,
  type FoodRegularityEvent,
} from "@/lib/food-regularity";
import { shiftDateStr } from "@/lib/date";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";

const TODAY = "2026-08-09";

// `daysAgo` days back from TODAY.
const day = (daysAgo: number) => shiftDateStr(TODAY, -daysAgo);

// One event per (day, group) in a window.
function events(
  window: FoodSlot,
  groupKey: string,
  daysAgo: readonly number[]
): FoodRegularityEvent[] {
  return daysAgo.map((n) => ({ groupKey, date: day(n), window }));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("foodRegularity", () => {
  it("measures a group's share over the days its WINDOW was logged, not over the span", () => {
    // Breakfast logged on 10 of the last 20 days; fermented on every one of them,
    // berries on 6. The ten unlogged mornings are silent about both.
    const logged = range(1, 10);
    const measure = foodRegularity(
      [
        ...events("Morning", "fermented", logged),
        ...events("Morning", "berries", logged.slice(0, 6)),
      ],
      { today: TODAY }
    );
    const morning = measure.Morning;
    expect(morning).not.toBeNull();
    expect(morning!.observedDays).toBe(10);
    expect(morning!.groups).toEqual([
      { groupKey: "fermented", days: 10, share: 1 },
      { groupKey: "berries", days: 6, share: 0.6 },
    ]);
    // A window nobody logged has no measure at all.
    expect(measure.Midday).toBeNull();
    expect(measure.Evening).toBeNull();
  });

  it("counts a day once however many servings it holds", () => {
    const twice = range(1, 8).flatMap((n) => [
      { groupKey: "eggs", date: day(n), window: "Morning" as const },
      { groupKey: "eggs", date: day(n), window: "Morning" as const },
    ]);
    const morning = foodRegularity(twice, { today: TODAY }).Morning;
    expect(morning!.observedDays).toBe(8);
    expect(morning!.groups).toEqual([{ groupKey: "eggs", days: 8, share: 1 }]);
  });

  it("ignores events outside the bounded span, on either side", () => {
    const inside = range(0, FOOD_REGULARITY_SPAN_DAYS - 1);
    const measure = foodRegularity(
      [
        ...events("Evening", "berries", inside),
        // One day older than the span, and one in the future — neither is evidence.
        ...events("Evening", "berries", [FOOD_REGULARITY_SPAN_DAYS]),
        {
          groupKey: "berries",
          date: shiftDateStr(TODAY, 1),
          window: "Evening",
        },
      ],
      { today: TODAY }
    );
    expect(measure.Evening!.observedDays).toBe(FOOD_REGULARITY_SPAN_DAYS);
  });

  it("keeps windows independent — a breakfast habit says nothing about dinner", () => {
    const measure = foodRegularity(
      [
        ...events("Morning", "fermented", range(1, 10)),
        ...events("Evening", "red_meat", range(1, 3)),
      ],
      { today: TODAY }
    );
    expect(measure.Morning!.groups[0].groupKey).toBe("fermented");
    expect(measure.Evening).toBeNull();
  });

  it("orders groups by share, then days, then key — a total, reproducible order", () => {
    const measure = foodRegularity(
      [
        ...events("Midday", "zzz_late", range(1, 7)),
        ...events("Midday", "aaa_early", range(1, 7)),
        ...events("Midday", "sometimes", range(1, 3)),
      ],
      { today: TODAY }
    );
    expect(measure.Midday!.groups.map((g) => g.groupKey)).toEqual([
      "aaa_early",
      "zzz_late",
      "sometimes",
    ]);
  });
});

describe("the declared gate produces silence, not a hedge (#2380)", () => {
  const withObservedDays = (n: number) =>
    foodRegularity(events("Morning", "fermented", range(1, n)), {
      today: TODAY,
    }).Morning;

  it(`is null at ${FOOD_REGULARITY_MIN_WINDOW_DAYS - 1} observed days`, () => {
    expect(withObservedDays(FOOD_REGULARITY_MIN_WINDOW_DAYS - 1)).toBeNull();
  });

  it(`reports at exactly ${FOOD_REGULARITY_MIN_WINDOW_DAYS}`, () => {
    const morning = withObservedDays(FOOD_REGULARITY_MIN_WINDOW_DAYS);
    expect(morning).not.toBeNull();
    expect(morning!.observedDays).toBe(FOOD_REGULARITY_MIN_WINDOW_DAYS);
  });

  it("a null window yields no habitual groups — no expectation, not a broken one", () => {
    expect(habitualFoodGroups(null)).toEqual([]);
  });

  it("an empty ledger is silent in every window", () => {
    const measure = foodRegularity([], { today: TODAY });
    for (const window of FOOD_SLOTS) expect(measure[window]).toBeNull();
  });
});

describe("habitualFoodGroups", () => {
  // 10 observed mornings: a 6/10 group is exactly at the threshold, a 5/10 is under.
  const measure = foodRegularity(
    [
      ...events("Morning", "fermented", range(1, 10)),
      ...events("Morning", "berries", range(1, 6)),
      ...events("Morning", "eggs", range(1, 5)),
    ],
    { today: TODAY }
  );

  it("keeps a group at the share threshold and drops the one below it", () => {
    expect(FOOD_REGULARITY_HABITUAL_SHARE).toBe(0.6);
    expect(habitualFoodGroups(measure.Morning).map((g) => g.groupKey)).toEqual([
      "fermented",
      "berries",
    ]);
  });

  it("drops an excluded (cap-direction) group without disturbing the rest", () => {
    const withAlcohol = foodRegularity(
      [
        ...events("Evening", "alcohol", range(1, 10)),
        ...events("Evening", "berries", range(1, 10)),
      ],
      { today: TODAY }
    );
    // Measured — the arithmetic is entitled to it …
    expect(withAlcohol.Evening!.groups.map((g) => g.groupKey)).toContain(
      "alcohol"
    );
    // … and never PRESENTED as an expectation.
    expect(
      habitualFoodGroups(withAlcohol.Evening, {
        excluded: new Set(["alcohol"]),
      }).map((g) => g.groupKey)
    ).toEqual(["berries"]);
  });
});

describe("usualFoodOffer", () => {
  const habitual = ["fermented", "berries", "eggs"];

  it("offers the habitual groups not already logged in the window", () => {
    expect(usualFoodOffer(habitual, new Set(["eggs"]))).toEqual([
      "fermented",
      "berries",
    ]);
  });

  it(`is empty below ${FOOD_USUAL_MIN_GROUPS} remaining — the bar is already one tap`, () => {
    expect(usualFoodOffer(habitual, new Set(["fermented", "berries"]))).toEqual(
      []
    );
    expect(usualFoodOffer(habitual.slice(0, 1), new Set())).toEqual([]);
  });

  it("is empty once the whole usual set is logged", () => {
    expect(
      usualFoodOffer(habitual, new Set(["fermented", "berries", "eggs"]))
    ).toEqual([]);
  });

  it("has nothing to offer when there is no habit", () => {
    expect(usualFoodOffer([], new Set())).toEqual([]);
  });
});
