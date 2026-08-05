// Shared slot-derivation over the food_log_events ledger (issues #950, #1016). This is
// the ONE code path that decides which food WINDOW an event belongs to — an explicit
// meal_slot when present, otherwise its logged_at instant in the profile's timezone +
// configured slot boundaries — and it is consumed by
// BOTH:
//   • the #950 slot RANKING signal (getFoodGroupLogOrder's slot occurrences), and
//   • the #1016 slot-scoped nudge button COUNTS (getFoodSlotServingsOnDate).
// Because ranking and count share this derivation, they can never disagree about which
// slot a tap falls in — a boundary-time tap buckets identically for both (#221 — one
// shared fixture pins them). Pure (zonedDateParts + foodSlotForHhmm are pure), so it's
// unit-tested without a DB.

import { zonedDateParts } from "./date";
import {
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";

// A food_log_events row as the ranking/count read it: the group_key, logged day, tap
// instant, and optional explicit consumed window.
export interface FoodLedgerEvent {
  name: string; // group_key
  date: string; // YYYY-MM-DD (the logged day)
  logged_at: string; // ISO-8601 UTC instant of the tap
  meal_slot?: FoodSlot | null; // explicit consumed window; null on legacy/tap-only rows
  eaten_at?: string | null; // captured EATING instant (#2019); null when nobody said
}

// The event's food window, in strict precedence:
//
//   1. an explicit `meal_slot` — the web bar's tab, which is a DECLARATION;
//   2. `eaten_at` — a captured eating instant (#2019), so a Telegram serving lands in
//      the window it was actually eaten in, and a corrected one MOVES there;
//   3. `logged_at` — LEGACY ONLY, and the reason #2019 exists. The tap stamp is not
//      eating time (migration 056 says so in as many words); it is all a pre-#2019 row
//      has, so a historical event keeps deriving from it rather than losing its meal.
//
// The consequence that matters: the read-time re-labelling — where editing a supplement
// reminder hour silently moved which meal a historical serving belonged to — no longer
// touches anything logged since #2019, because those rows carry their own instant.
export function foodEventWindow(
  loggedAt: string,
  tz: string,
  boundaries: FoodSlotBoundaries,
  explicitSlot?: FoodSlot | null,
  eatenAt?: string | null
): FoodSlot {
  if (explicitSlot) return explicitSlot;
  const { hhmm } = zonedDateParts(tz, new Date(eatenAt ?? loggedAt));
  return foodSlotForHhmm(hhmm, boundaries);
}

// The ledger events whose derived window matches `window` — the #950 slot frecency
// source consumed by getFoodGroupLogOrder.
export function foodEventsInWindow(
  events: readonly FoodLedgerEvent[],
  tz: string,
  boundaries: FoodSlotBoundaries,
  window: FoodSlot
): FoodLedgerEvent[] {
  return events.filter(
    (e) =>
      foodEventWindow(e.logged_at, tz, boundaries, e.meal_slot, e.eaten_at) ===
      window
  );
}

// Slot-scoped per-group serving counts for a single DAY (#1016): the day's ledger events
// whose derived window matches, tallied by group_key. This is what the Telegram nudge's
// button "(n)" suffix reads — "n servings logged in THIS window today" — while the tally
// line stays the day total. Only events whose logged DAY equals `date` count (a backfilled
// yesterday tap has date=yesterday and is excluded from today's slot count). Shares
// foodEventWindow with the ranking, so a tap counts for exactly the slot it ranks in.
export function slotServingCounts(
  events: readonly FoodLedgerEvent[],
  tz: string,
  boundaries: FoodSlotBoundaries,
  window: FoodSlot,
  date: string
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.date !== date) continue;
    if (
      foodEventWindow(e.logged_at, tz, boundaries, e.meal_slot, e.eaten_at) !==
      window
    )
      continue;
    m.set(e.name, (m.get(e.name) ?? 0) + 1);
  }
  return m;
}
