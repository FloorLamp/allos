import { describe, expect, it } from "vitest";
import { applyFoodServingPlacements } from "@/lib/food-serving-projection";

describe("applyFoodServingPlacements", () => {
  it("publishes both halves of a same-group meal correction as one projection", () => {
    const projected = applyFoodServingPlacements(
      {
        "2026-08-24": { nuts_seeds: 1, berries: 2 },
      },
      {
        "2026-08-24": {
          Morning: { nuts_seeds: 1, berries: 1 },
          Midday: { berries: 1 },
          Evening: {},
        },
      },
      [
        {
          date: "2026-08-24",
          groupKey: "nuts_seeds",
          mealSlot: "Morning",
          servings: 1,
          mealServings: 0,
        },
        {
          date: "2026-08-24",
          groupKey: "nuts_seeds",
          mealSlot: "Evening",
          servings: 1,
          mealServings: 1,
        },
      ]
    );

    expect(projected.countsByDate["2026-08-24"]).toEqual({
      nuts_seeds: 1,
      berries: 2,
    });
    expect(projected.slotCountsByDate["2026-08-24"]).toEqual({
      Morning: { nuts_seeds: 0, berries: 1 },
      Midday: { berries: 1 },
      Evening: { nuts_seeds: 1 },
    });
  });
});
