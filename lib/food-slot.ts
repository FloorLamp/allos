// Pure slot derivation for the food-log ledger (issue #950) — DB-free so it's
// unit-tested (lib/__tests__). A tap's `logged_at` (a UTC instant) plus the
// profile's timezone give a local minute-of-day; this maps that minute to one of
// three food windows — Morning / Midday / Evening — used to make button ranking
// slot-aware and to label the current window on the Food tab. ONE derivation for
// both surfaces (the web bar and the Telegram nudge), so they can never disagree
// about what "midday" means for a shifted schedule.
//
// Food space has exactly THREE windows (no bedtime cut): a post-bedtime dinner tap
// counts as Evening, which runs from the midday/evening boundary to MIDNIGHT. This
// deliberately does NOT borrow supplement-schedule's `currentTimeBucket` 21:00
// "Before sleep" split — the bedtime DOSE slot does not partition food.

// The three food windows. Same string values as the Telegram nudge's FoodNudgeWindow
// (lib/notifications/food-format) so a window flows unchanged between the surfaces.
export type FoodSlot = "Morning" | "Midday" | "Evening";
export const FOOD_SLOTS: readonly FoodSlot[] = ["Morning", "Midday", "Evening"];

// Fallback boundaries (minutes-of-day) used when the profile has NOT configured a
// full morning/midday/evening notify schedule. Reproduce currentTimeBucket's fixed
// 11:00 / 15:00 splits (the pre-#950 behavior), with Evening running to midnight.
export const DEFAULT_MIDDAY_BOUNDARY_MIN = 11 * 60; // 11:00
export const DEFAULT_EVENING_BOUNDARY_MIN = 15 * 60; // 15:00

export interface FoodSlotBoundaries {
  // Minute-of-day where Morning ends and Midday begins.
  midday: number;
  // Minute-of-day where Midday ends and Evening begins (Evening runs to midnight).
  evening: number;
}

// Resolve the two bucket boundaries from the profile's configured notify slot HOURS
// (each 0–23, or null when unset/off). Anchored to the profile's OWN schedule so a
// coherently shifted rhythm re-anchors the buckets (a 14:00 morning hour with an
// 18:00 midday hour keeps 14:00 in "morning"): the boundaries sit at the MIDPOINTS
// between consecutive slot hours.
//
// Only a FULLY configured schedule (all three hours set) re-anchors; otherwise we
// fall back to the fixed 11:00/15:00 defaults so a fresh/partially-configured profile
// reproduces the old currentTimeBucket splits exactly (and a degenerate non-monotonic
// configuration can't invert the buckets). Midpoint of hours h1,h2 in minutes is
// (h1+h2)/2*60 = (h1+h2)*30.
export function foodSlotBoundaries(hours: {
  morning: number | null;
  midday: number | null;
  evening: number | null;
}): FoodSlotBoundaries {
  const { morning, midday, evening } = hours;
  if (
    morning != null &&
    midday != null &&
    evening != null &&
    // Guard: the midpoint math only makes sense for an ORDERED schedule
    // (morning ≤ midday ≤ evening). A degenerate configuration (midday earlier than
    // morning) falls back to the fixed defaults rather than inverting the buckets.
    morning <= midday &&
    midday <= evening
  ) {
    const b1 = Math.round((morning + midday) * 30);
    const b2 = Math.round((midday + evening) * 30);
    if (b1 < b2 && b2 <= 24 * 60) return { midday: b1, evening: b2 };
  }
  return {
    midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
    evening: DEFAULT_EVENING_BOUNDARY_MIN,
  };
}

// The food window a local minute-of-day (0–1439) falls into, given the boundaries.
// Evening is terminal (runs through midnight), so anything at/after the evening
// boundary is Evening.
export function deriveFoodSlot(
  minutesOfDay: number,
  b: FoodSlotBoundaries
): FoodSlot {
  if (minutesOfDay < b.midday) return "Morning";
  if (minutesOfDay < b.evening) return "Midday";
  return "Evening";
}

// Convenience: derive a food slot straight from an "HH:MM" wall-clock string and the
// boundaries. Malformed input folds to minute 0 (Morning) rather than throwing.
export function foodSlotForHhmm(
  hhmm: string,
  b: FoodSlotBoundaries
): FoodSlot {
  const [h, m] = hhmm.split(":");
  const mins = (Number(h) || 0) * 60 + (Number(m) || 0);
  return deriveFoodSlot(mins, b);
}
