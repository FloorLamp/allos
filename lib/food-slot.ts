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
// deliberately does NOT borrow intake-schedule's `currentTimeBucket` 21:00
// "Before sleep" split — the bedtime DOSE slot does not partition food.

import { hhmmToMinutes } from "./date";

// The three food windows. Same string values as the Telegram nudge's FoodNudgeWindow
// (lib/notifications/food-format) so a window flows unchanged between the surfaces.
export type FoodSlot = "Morning" | "Midday" | "Evening";
export const FOOD_SLOTS: readonly FoodSlot[] = ["Morning", "Midday", "Evening"];

export function isFoodSlot(value: unknown): value is FoodSlot {
  return (
    typeof value === "string" &&
    (FOOD_SLOTS as readonly string[]).includes(value)
  );
}

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

// Resolve the two bucket boundaries from the profile's configured notify slot
// TIMES (each a minute of day, or null when unset/off — minutes since #2121).
// Anchored to the profile's OWN schedule so a coherently shifted rhythm re-anchors
// the buckets (a 14:00 morning slot with an 18:00 midday slot keeps 14:00 in
// "morning"): the boundaries sit at the MIDPOINTS between consecutive slot times.
//
// Only a FULLY configured schedule (all three times set) re-anchors; otherwise we
// fall back to the fixed 11:00/15:00 defaults so a fresh/partially-configured profile
// reproduces the old currentTimeBucket splits exactly (and a degenerate non-monotonic
// configuration can't invert the buckets).
export function foodSlotBoundaries(minutes: {
  morning: number | null;
  midday: number | null;
  evening: number | null;
}): FoodSlotBoundaries {
  const { morning, midday, evening } = minutes;
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
    const b1 = Math.round((morning + midday) / 2);
    const b2 = Math.round((midday + evening) / 2);
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
export function foodSlotForHhmm(hhmm: string, b: FoodSlotBoundaries): FoodSlot {
  return deriveFoodSlot(hhmmToMinutes(hhmm), b);
}

// ---- Slot ANCHORS: the point a window is "about" (issue #2019) ----

// The default anchor minute-of-day for each window, used when the profile has not
// configured a full notify schedule. These are meal times, not bucket midpoints: the
// midpoint of the default Morning bucket [00:00, 11:00) is 05:30, which is nobody's
// breakfast, and anchoring proximity there would rank a 05:30 snack above an 08:00 one
// for the morning nudge.
export const DEFAULT_SLOT_ANCHORS: Record<FoodSlot, number> = {
  Morning: 8 * 60,
  Midday: 12 * 60 + 30,
  Evening: 18 * 60 + 30,
};

// The anchor minute for each window, from the profile's configured notify slot
// TIMES — the SAME three numbers `foodSlotBoundaries` derives its midpoints from,
// so anchors and boundaries can never describe two different schedules. A
// coherently shifted rhythm (14:00 morning, 18:00 midday) moves the anchors with
// it; a partial or non-monotonic configuration falls back to the defaults, exactly
// as the boundaries do.
export function foodSlotAnchors(minutes: {
  morning: number | null;
  midday: number | null;
  evening: number | null;
}): Record<FoodSlot, number> {
  const { morning, midday, evening } = minutes;
  if (
    morning != null &&
    midday != null &&
    evening != null &&
    morning <= midday &&
    midday <= evening
  ) {
    return {
      Morning: morning,
      Midday: midday,
      Evening: evening,
    };
  }
  return { ...DEFAULT_SLOT_ANCHORS };
}

// Minutes between two points on a 24-hour CLOCK, the short way round. 23:30 and 00:30
// are sixty minutes apart, not 1380 — which is what stops a late-evening habit from
// reading as maximally distant from an early-morning nudge.
export function clockDistanceMin(a: number, b: number): number {
  const d = Math.abs(a - b) % (24 * 60);
  return Math.min(d, 24 * 60 - d);
}
