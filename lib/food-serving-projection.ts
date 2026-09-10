import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";

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

// SET ONE COORDINATE IN BOTH PROJECTIONS AT ONCE, from the caller's own transform of
// the pair it already holds. Both halves move together for the same reason placements
// fold together above: a day total and the meal total inside it are one fact seen from
// two distances, and publishing either alone lets a render show a day that its own
// meals do not add up to. Clamped at zero here rather than at each call site, because
// an optimistic decrement is the only producer of a negative and it has no better
// answer than "none".
export function setFoodServingCount(
  countsByDate: FoodCountsByDate,
  slotCountsByDate: FoodSlotCountsByDate,
  date: string,
  mealSlot: FoodSlot,
  groupKey: string,
  next: (prev: { day: number; meal: number }) => { day: number; meal: number }
): { countsByDate: FoodCountsByDate; slotCountsByDate: FoodSlotCountsByDate } {
  const dayCounts = countsByDate[date] ?? {};
  const slotDay = slotCountsByDate[date] ?? {
    Morning: {},
    Midday: {},
    Evening: {},
  };
  const mealCounts = slotDay[mealSlot] ?? {};
  const value = next({
    day: dayCounts[groupKey] ?? 0,
    meal: mealCounts[groupKey] ?? 0,
  });
  return applyFoodServingPlacements(countsByDate, slotCountsByDate, [
    {
      date,
      groupKey,
      mealSlot,
      servings: Math.max(0, value.day),
      mealServings: Math.max(0, value.meal),
    },
  ]);
}

// ADOPT ONE POST-BURST SERVER SNAPSHOT for a whole day/group coordinate. Unlike a
// placement this names EVERY meal window, not just the one that moved: a burst can
// spread across windows, and repairing only the latest one would leave an earlier row
// optimistic or stale while the day total beside it had already been corrected.
export function applyFoodServingTruth(
  countsByDate: FoodCountsByDate,
  slotCountsByDate: FoodSlotCountsByDate,
  date: string,
  groupKey: string,
  truth: { servings: number; mealServings: Record<FoodSlot, number> }
): { countsByDate: FoodCountsByDate; slotCountsByDate: FoodSlotCountsByDate } {
  return applyFoodServingPlacements(
    countsByDate,
    slotCountsByDate,
    FOOD_SLOTS.map((mealSlot) => ({
      date,
      groupKey,
      mealSlot,
      servings: truth.servings,
      mealServings: truth.mealServings[mealSlot],
    }))
  );
}
