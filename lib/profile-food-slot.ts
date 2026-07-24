// Profile-aware food-slot resolution shared by reads and writes. The slot boundaries
// come from the profile's configured morning/midday/evening schedule; a stored explicit
// meal slot wins, while legacy events fall back to their tap instant.

import { getProfileSetting, getTimezone } from "./settings";
import {
  foodSlotBoundaries,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";
import { zonedDateParts } from "./date";

export function profileFoodSlotBoundaries(
  profileId: number
): FoodSlotBoundaries {
  const raw = (key: string): number | null => {
    const value = getProfileSetting(profileId, key);
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  return foodSlotBoundaries({
    morning: raw("notify_supp_morning_hour"),
    midday: raw("notify_supp_midday_hour"),
    evening: raw("notify_supp_evening_hour"),
  });
}

export function foodSlotForProfileInstant(
  profileId: number,
  instant: Date
): FoodSlot {
  const { hhmm } = zonedDateParts(getTimezone(profileId), instant);
  return foodSlotForHhmm(hhmm, profileFoodSlotBoundaries(profileId));
}

export function foodSlotForProfileEvent(
  profileId: number,
  loggedAt: string,
  explicitSlot?: FoodSlot | null
): FoodSlot {
  if (explicitSlot) return explicitSlot;
  return foodSlotForProfileInstant(profileId, new Date(loggedAt));
}
