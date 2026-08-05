// Profile-aware food-slot resolution shared by reads and writes. The slot boundaries
// come from the profile's configured morning/midday/evening schedule; a stored explicit
// meal slot wins, while legacy events fall back to their tap instant.

import { getProfileSetting, getTimezone } from "./settings";
import {
  foodSlotAnchors,
  foodSlotBoundaries,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";
import { zonedDateParts } from "./date";

// The profile's configured notify slot HOURS (0–23 each, or null when unset/off) — the
// one read both the bucket boundaries and the ranking anchors are derived from, so the
// two can never describe different schedules.
function profileSlotHours(profileId: number): {
  morning: number | null;
  midday: number | null;
  evening: number | null;
} {
  const raw = (key: string): number | null => {
    const value = getProfileSetting(profileId, key);
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  return {
    morning: raw("notify_supp_morning_hour"),
    midday: raw("notify_supp_midday_hour"),
    evening: raw("notify_supp_evening_hour"),
  };
}

export function profileFoodSlotBoundaries(
  profileId: number
): FoodSlotBoundaries {
  return foodSlotBoundaries(profileSlotHours(profileId));
}

// The profile's per-window ranking anchors (#2019) — the point each window is "about",
// which proximity weighting measures a tap's distance from.
export function profileFoodSlotAnchors(
  profileId: number
): Record<FoodSlot, number> {
  return foodSlotAnchors(profileSlotHours(profileId));
}

export function foodSlotForProfileInstant(
  profileId: number,
  instant: Date
): FoodSlot {
  const { hhmm } = zonedDateParts(getTimezone(profileId), instant);
  return foodSlotForHhmm(hhmm, profileFoodSlotBoundaries(profileId));
}

// The window one ledger event sits in. See `foodEventWindow` (lib/food-slot-count.ts)
// for the precedence and why `logged_at` is now the LAST resort rather than the
// derivation (#2019).
export function foodSlotForProfileEvent(
  profileId: number,
  loggedAt: string,
  explicitSlot?: FoodSlot | null,
  eatenAt?: string | null
): FoodSlot {
  if (explicitSlot) return explicitSlot;
  return foodSlotForProfileInstant(profileId, new Date(eatenAt ?? loggedAt));
}
