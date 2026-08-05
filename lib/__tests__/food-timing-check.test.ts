// PURE TIER — the declared-timing × ledger truth table (issue #2022), boundary-pinned.
// The clause is informational and rides an existing send, so the only thing that can go
// wrong here is WHAT IT SAYS: a clause on an `any` dose would drown every reminder, and
// a clause phrased about the person would be a claim the ledger cannot support.

import { describe, it, expect } from "vitest";
import {
  EMPTY_STOMACH_RECENT_MIN,
  FOOD_CHECK_LOOKBACK_MIN,
  WITH_FOOD_RECENT_MIN,
  foodRecencyPhrase,
  foodTimingCheck,
  foodTimingCheckNote,
} from "@/lib/food-timing-check";
import type { FoodTiming } from "@/lib/types/intake";

const ALL_TIMINGS: FoodTiming[] = [
  "any",
  "with_food",
  "with_fat",
  "before_meal",
  "empty_stomach",
];

const note = (timing: FoodTiming, minutes: number | null) =>
  foodTimingCheckNote(foodTimingCheck(timing, minutes));

describe("foodTimingCheck truth table (#2022)", () => {
  it("`any` never produces a clause, whatever the ledger holds", () => {
    for (const minutes of [null, 0, 5, 30, 59, 60, 89, 90, 91, 1000]) {
      expect(foodTimingCheck("any", minutes)).toEqual({ kind: "none" });
      expect(note("any", minutes)).toBe("");
    }
  });

  it("with_food / with_fat flag an empty ledger and stay quiet after a serving", () => {
    for (const timing of ["with_food", "with_fat"] as const) {
      expect(foodTimingCheck(timing, null)).toEqual({ kind: "nothing-logged" });
      expect(foodTimingCheck(timing, 10)).toEqual({ kind: "none" });
    }
  });

  it("empty_stomach / before_meal name a recent serving and stay quiet without one", () => {
    for (const timing of ["empty_stomach", "before_meal"] as const) {
      expect(foodTimingCheck(timing, 20)).toEqual({
        kind: "food-logged",
        minutesAgo: 20,
      });
      expect(foodTimingCheck(timing, null)).toEqual({ kind: "none" });
    }
  });

  it("pins the with-food boundary: at the window quiet, one minute past it flags", () => {
    expect(foodTimingCheck("with_food", WITH_FOOD_RECENT_MIN)).toEqual({
      kind: "none",
    });
    expect(foodTimingCheck("with_food", WITH_FOOD_RECENT_MIN + 1)).toEqual({
      kind: "nothing-logged",
    });
  });

  it("pins the empty-stomach boundary: at the window it names, one minute past it is quiet", () => {
    expect(foodTimingCheck("empty_stomach", EMPTY_STOMACH_RECENT_MIN)).toEqual({
      kind: "food-logged",
      minutesAgo: EMPTY_STOMACH_RECENT_MIN,
    });
    expect(
      foodTimingCheck("empty_stomach", EMPTY_STOMACH_RECENT_MIN + 1)
    ).toEqual({ kind: "none" });
  });

  it("the two windows differ, and the lookback covers the wider one", () => {
    // A serving 75 min ago satisfies with_food and is already too old to be worth
    // naming to an empty_stomach dose — the two clauses answer different questions.
    expect(foodTimingCheck("with_food", 75)).toEqual({ kind: "none" });
    expect(foodTimingCheck("empty_stomach", 75)).toEqual({ kind: "none" });
    expect(FOOD_CHECK_LOOKBACK_MIN).toBe(
      Math.max(WITH_FOOD_RECENT_MIN, EMPTY_STOMACH_RECENT_MIN)
    );
  });

  it("reads a slightly-future stated instant as `just now` rather than rejecting it", () => {
    expect(foodTimingCheck("empty_stomach", -2)).toEqual({
      kind: "food-logged",
      minutesAgo: 0,
    });
    expect(note("empty_stomach", -2)).toBe("food logged just now");
  });

  it("treats a non-finite reading as no reading at all", () => {
    expect(foodTimingCheck("with_food", Number.NaN)).toEqual({
      kind: "nothing-logged",
    });
    expect(foodTimingCheck("empty_stomach", Number.NaN)).toEqual({
      kind: "none",
    });
  });

  it("every timing resolves to exactly one of the three outcomes", () => {
    for (const timing of ALL_TIMINGS) {
      for (const minutes of [null, 0, 45, 120]) {
        expect(["none", "nothing-logged", "food-logged"]).toContain(
          foodTimingCheck(timing, minutes).kind
        );
      }
    }
  });
});

describe("the clause's wording (#2022)", () => {
  it("names the LOG, never the person", () => {
    const nothing = note("with_food", null);
    const recent = note("empty_stomach", 20);
    for (const text of [nothing, recent]) {
      expect(text).toContain("logged");
      expect(text).not.toMatch(/\byou\b/i);
      expect(text).not.toMatch(/\bate\b|\beaten\b|\beat\b/i);
    }
  });

  it("states its own horizon rather than implying the whole day", () => {
    expect(note("with_food", null)).toBe(
      `no food logged in the last ${WITH_FOOD_RECENT_MIN} min`
    );
  });

  it("rounds recency to five minutes and says `just now` below that", () => {
    expect(foodRecencyPhrase(0)).toBe("just now");
    expect(foodRecencyPhrase(4)).toBe("just now");
    expect(foodRecencyPhrase(5)).toBe("~5 min ago");
    expect(foodRecencyPhrase(22)).toBe("~20 min ago");
    expect(foodRecencyPhrase(23)).toBe("~25 min ago");
    expect(foodRecencyPhrase(58)).toBe("~60 min ago");
  });

  it("renders a recency clause for a named serving", () => {
    expect(note("before_meal", 20)).toBe("food logged ~20 min ago");
  });
});
