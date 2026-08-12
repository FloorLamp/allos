// Profile-aware food-slot resolution shared by reads and writes. The slot boundaries
// come from the profile's configured morning/midday/evening schedule; a stored explicit
// meal slot wins, while legacy events fall back to their tap instant.

import { getProfileSetting, getTimezone } from "./settings";
import { parseNotifyTime } from "./notifications/schedule";
import {
  foodSlotAnchors,
  foodSlotBoundaries,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";
import { zonedDateParts } from "./date";

// The profile's configured notify slot TIMES (minutes of day, or null when
// unset/off) — the one read both the bucket boundaries and the ranking anchors are
// derived from, so the two can never describe different schedules. Parsed through
// the shared parseNotifyTime so the stored "HH:MM" format (and its legacy integer
// fallback) has ONE reader. Absent and "auto" both resolve to null here, exactly
// as this module always treated them: the food buckets re-anchor only on a fully
// MANUAL schedule, and chasing the wake time would put a sleep read on every food
// ranking.
function profileSlotMinutes(profileId: number): {
  morning: number | null;
  midday: number | null;
  evening: number | null;
} {
  const raw = (key: string): number | null =>
    parseNotifyTime(getProfileSetting(profileId, key), null, null);
  return {
    morning: raw("notify_supp_morning_hour"),
    midday: raw("notify_supp_midday_hour"),
    evening: raw("notify_supp_evening_hour"),
  };
}

export function profileFoodSlotBoundaries(
  profileId: number
): FoodSlotBoundaries {
  return foodSlotBoundaries(profileSlotMinutes(profileId));
}

// The profile's per-window ranking anchors (#2019) — the point each window is "about",
// which proximity weighting measures a tap's distance from.
export function profileFoodSlotAnchors(
  profileId: number
): Record<FoodSlot, number> {
  return foodSlotAnchors(profileSlotMinutes(profileId));
}

export function foodSlotForProfileInstant(
  profileId: number,
  instant: Date
): FoodSlot {
  const { hhmm } = zonedDateParts(getTimezone(profileId), instant);
  return foodSlotForHhmm(hhmm, profileFoodSlotBoundaries(profileId));
}

// The window one ledger event sits in. See `foodEventWindow` (lib/food-slot-count.ts)
// for the precedence and why `recorded_at` is now the LAST resort rather than the
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
