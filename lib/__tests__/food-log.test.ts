import { describe, it, expect } from "vitest";
import {
  rollupServings,
  totalServings,
  servingsForGroup,
  type FoodLogEntry,
} from "@/lib/food-log";
import { FOOD_GROUPS } from "@/lib/food-groups";

// Pure-tier tests for the weekly food-servings rollup (issue #579) — the ONE
// computation the journal card, the trends view, and #580 habit progress all format.

const e = (date: string, group: string, servings: number): FoodLogEntry => ({
  date,
  group_key: group,
  servings,
});

describe("rollupServings", () => {
  it("sums servings per group across days", () => {
    const out = rollupServings([
      e("2026-07-06", "fatty_fish", 1),
      e("2026-07-08", "fatty_fish", 1),
      e("2026-07-08", "legumes", 2),
    ]);
    const byKey = Object.fromEntries(out.map((g) => [g.slug, g.servings]));
    expect(byKey.fatty_fish).toBe(2);
    expect(byKey.legumes).toBe(2);
  });

  it("omits zero-serving entries and never emits an empty-count group", () => {
    const out = rollupServings([
      e("2026-07-06", "fatty_fish", 0),
      e("2026-07-06", "legumes", 1),
    ]);
    expect(out.map((g) => g.slug)).toEqual(["legumes"]);
  });

  it("orders by the catalog (encourage-first), not by input order", () => {
    // legumes (encourage) appears before red_meat (neutral) regardless of input order.
    const out = rollupServings([
      e("2026-07-06", "red_meat", 1),
      e("2026-07-06", "legumes", 1),
    ]);
    const idxLegumes = FOOD_GROUPS.findIndex((g) => g.slug === "legumes");
    const idxRed = FOOD_GROUPS.findIndex((g) => g.slug === "red_meat");
    expect(idxLegumes).toBeLessThan(idxRed);
    expect(out.map((g) => g.slug)).toEqual(["legumes", "red_meat"]);
  });

  it("surfaces a retired/unknown slug rather than dropping it (history renders)", () => {
    const out = rollupServings([e("2026-07-06", "ancient_grains_retired", 3)]);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("ancient_grains_retired");
    expect(out[0].name).toBe("ancient_grains_retired");
    expect(out[0].servings).toBe(3);
  });

  it("carries the group's tier", () => {
    const out = rollupServings([e("2026-07-06", "alcohol", 2)]);
    expect(out[0].tier).toBe("limit");
  });
});

describe("totalServings / servingsForGroup", () => {
  const entries = [
    e("2026-07-06", "fatty_fish", 1),
    e("2026-07-07", "fatty_fish", 1),
    e("2026-07-07", "legumes", 2),
  ];
  it("totalServings sums everything", () => {
    expect(totalServings(entries)).toBe(4);
  });
  it("servingsForGroup sums one group (the #580 progress read)", () => {
    expect(servingsForGroup(entries, "fatty_fish")).toBe(2);
    expect(servingsForGroup(entries, "red_meat")).toBe(0);
  });
});
