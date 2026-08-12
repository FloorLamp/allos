// Shared slot-derivation over the food_log_events ledger (issue #950; precedence
// re-settled by #2019). This is the ONE precedence that decides which food WINDOW an
// event belongs to — an explicit meal_slot when present, then a captured eating
// instant, then the tap instant, in the profile's timezone + configured boundaries.
//
// Its live consumers (#2227 corrected this list after #2019 retired one of them):
//   • the web log's meal grouping — getFoodMealDays' per-window tallies AND the
//     correction rows they are built in one pass with (lib/queries/nutrition.ts);
//   • the write-side reads, via the profile-resolving mirror foodSlotForProfileEvent
//     (lib/profile-food-slot.ts): mealServingCount's per-window dedupe and the
//     correction/delete cores' from/to/vacated placements (#1934/#1963/#2227);
//   • the same eaten-over-tap precedence, one level down, in the #2019 ranking signal
//     (slotProximityOccurrences weights each event at the minute it was EATEN when one
//     was captured) and the current-window chip (currentFoodSlot).
//
// What is NOT here any more: the #1016 slot-scoped nudge button count
// (getFoodSlotServingsOnDate / slotServingCounts) was retired by #2019 — the Telegram
// suffix reads the DAY total now (lib/notifications/food.ts says so outright), and the
// ranking weights by PROXIMITY rather than bucket membership. #2227 deleted the dead
// query rather than leave a derivation advertising consumers that no longer exist.
//
// Pure (zonedDateParts + foodSlotForHhmm are pure), so it's unit-tested without a DB.

import { zonedDateParts } from "./date";
import {
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";

// A food_log_events row as the window derivation reads it: the group_key, logged day,
// tap instant, and optional explicit consumed window.
export interface FoodLedgerEvent {
  name: string; // group_key
  date: string; // YYYY-MM-DD (the logged day)
  recorded_at: string; // ISO-8601 UTC instant of the tap
  meal_slot?: FoodSlot | null; // explicit consumed window; null on legacy/tap-only rows
  occurred_at?: string | null; // captured EATING instant (#2019); null when nobody said
}

// The event's food window, in strict precedence:
//
//   1. an explicit `meal_slot` — a DECLARATION (the backfill's tab) or an OVERRIDE
//      (the correction sheet's hand-set Meal). Never an echo: since #2269 the log
//      path stores no slot beside a stated eating time, so a row carries one only
//      when the user actually asserted a meal;
//   2. `occurred_at` — a captured or stated eating instant (#2019/#2269), so a serving
//      lands in the window it was actually eaten in, and a corrected one MOVES there;
//   3. `recorded_at` — LEGACY ONLY, and the reason #2019 exists. The tap stamp is not
//      eating time (migration 056 says so in as many words); it is all a pre-#2019 row
//      has, so a historical event keeps deriving from it rather than losing its meal.
//
// THE MUTABILITY CONTRACT, honestly stated (#2269 decision 3): a stored `meal_slot`
// FREEZES a row's window; an instant RE-BUCKETS under boundary edits, by design.
// The boundaries are the midpoints of the profile's configured Morning/Midday/Evening
// times, so pinning Morning to 05:43 moves the Morning/Midday split and a past 09:30
// serving becomes Midday with no write anywhere — the boundaries define what "midday"
// MEANS for this person, and history follows the definition. Carrying an instant fixes
// which MINUTE is read, not the boundaries it is read through; the only thing that
// freezes a label is a stored slot — which Telegram deliberately never writes, and
// which the web log path since #2269 writes only for a declaration-only backfill.
export function foodEventWindow(
  recordedAt: string,
  tz: string,
  boundaries: FoodSlotBoundaries,
  explicitSlot?: FoodSlot | null,
  occurredAt?: string | null
): FoodSlot {
  if (explicitSlot) return explicitSlot;
  const { hhmm } = zonedDateParts(tz, new Date(occurredAt ?? recordedAt));
  return foodSlotForHhmm(hhmm, boundaries);
}

// `foodEventsInWindow` and `slotServingCounts` used to live here as the count half of
// the module — the #1016 slot-scoped nudge button suffix. #2019 retired that suffix
// (the button count is the DAY total, and the ranking weights by proximity), and #2227
// removed the two functions with their last advertised consumer. The tests that pinned
// "a corrected serving changes window" moved onto `foodEventWindow` directly and onto
// the meal grouping the web surface renders (getFoodMealDays.slotCounts).
