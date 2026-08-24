import type { FoodSlot } from "@/lib/food-slot";

export type FoodCountsByDate = Record<string, Record<string, number>>;
export type FoodSlotCountsByDate = Record<
  string,
  Record<FoodSlot, Record<string, number>>
>;

export interface FoodServingPlacement {
  date: string;
  groupKey: string;
  mealSlot: FoodSlot;
  servings: number;
  mealServings: number;
}

// Fold every server-named coordinate before either client projection is published.
// A correction can name the same day/group twice (the window it left and the one it
// entered), so exposing either half as a standalone state transition can let a render
// restore the old sibling-window map between them.
export function applyFoodServingPlacements(
  countsByDate: FoodCountsByDate,
  slotCountsByDate: FoodSlotCountsByDate,
  placements: readonly FoodServingPlacement[]
): {
  countsByDate: FoodCountsByDate;
  slotCountsByDate: FoodSlotCountsByDate;
} {
  let nextCounts = countsByDate;
  let nextSlotCounts = slotCountsByDate;

  for (const placement of placements) {
    const day = nextCounts[placement.date] ?? {};
    nextCounts = {
      ...nextCounts,
      [placement.date]: {
        ...day,
        [placement.groupKey]: placement.servings,
      },
    };

    const slotDay = nextSlotCounts[placement.date] ?? {
      Morning: {},
      Midday: {},
      Evening: {},
    };
    nextSlotCounts = {
      ...nextSlotCounts,
      [placement.date]: {
        ...slotDay,
        [placement.mealSlot]: {
          ...(slotDay[placement.mealSlot] ?? {}),
          [placement.groupKey]: placement.mealServings,
        },
      },
    };
  }

  return { countsByDate: nextCounts, slotCountsByDate: nextSlotCounts };
}
