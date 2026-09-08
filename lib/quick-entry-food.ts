// The server-side Food gather shared by the quick-entry Action and the authenticated
// offline snapshot builder. Authorization, the profile-local day, and the capture
// instant are resolved by the caller; this module only gathers one profile's facts.

import { shiftDateStr, zonedDateParts } from "@/lib/date";
import { type FoodGroup } from "@/lib/food-groups";
import {
  FOOD_SLOTS,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import { formatWeekdayDate } from "@/lib/format-date";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { profileFoodSlotBoundaries } from "@/lib/profile-food-slot";
import {
  getFoodBarOrder,
  getFoodMealDays,
  getProteinDailyGrams,
  getProteinQuickAddPreset,
  type FoodMealEvent,
} from "@/lib/queries";
import { getDisplayFormatPrefs, getTimezone } from "@/lib/settings";
import {
  getExcludedFoodGroups,
  getProfileAge,
} from "@/lib/settings/profile-attrs";

export interface QuickEntryFoodDay {
  readonly date: string;
  readonly label: string;
  readonly counts: Record<string, number>;
  readonly slotCounts: Record<FoodSlot, Record<string, number>>;
  readonly events: FoodMealEvent[];
}

export interface QuickEntryFoodAvailable {
  readonly days: QuickEntryFoodDay[];
  readonly groupsBySlot: Record<FoodSlot, FoodGroup[]>;
  readonly proteinRankBySlot: Record<FoodSlot, number | null>;
  readonly grams: number;
  readonly preset: number | null;
  readonly exclusions: string[];
  readonly slot: FoodSlot;
  readonly boundaries: FoodSlotBoundaries;
}

export type QuickEntryFoodGather =
  | { readonly available: false }
  | ({ readonly available: true } & QuickEntryFoodAvailable);

export interface QuickEntryFoodGatherInput {
  readonly loginId: number;
  readonly today: string;
  readonly requestedDate: string;
  readonly now: Date;
}

export function gatherQuickEntryFood(
  profileId: number,
  input: QuickEntryFoodGatherInput
): QuickEntryFoodGather {
  if (!isFoodLoggingRelevant(getProfileAge(profileId))) {
    return { available: false };
  }

  const prefs = getDisplayFormatPrefs(input.loginId);
  const days = getFoodMealDays(profileId, [input.requestedDate]).map((day) => ({
    ...day,
    label:
      day.date === input.today
        ? "Today"
        : day.date === shiftDateStr(input.today, -1)
          ? "Yesterday"
          : formatWeekdayDate(day.date, prefs),
  }));
  const orderBySlot = Object.fromEntries(
    FOOD_SLOTS.map((meal) => [meal, getFoodBarOrder(profileId, meal)])
  ) as Record<FoodSlot, ReturnType<typeof getFoodBarOrder>>;
  const boundaries = profileFoodSlotBoundaries(profileId);
  const localTime = zonedDateParts(getTimezone(profileId), input.now).hhmm;

  return {
    available: true,
    days,
    groupsBySlot: Object.fromEntries(
      FOOD_SLOTS.map((meal) => [meal, orderBySlot[meal].groups])
    ) as Record<FoodSlot, FoodGroup[]>,
    proteinRankBySlot: Object.fromEntries(
      FOOD_SLOTS.map((meal) => [meal, orderBySlot[meal].proteinRank])
    ) as Record<FoodSlot, number | null>,
    grams: getProteinDailyGrams(profileId, input.requestedDate),
    preset: getProteinQuickAddPreset(profileId),
    exclusions: getExcludedFoodGroups(profileId),
    slot: foodSlotForHhmm(localTime, boundaries),
    boundaries,
  };
}
