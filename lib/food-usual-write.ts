// Auth-blind write core for the "log my usual <window>" offer (issue #2380).
// profileId first, never imports lib/auth — the Server Action owns the gate.
//
// ── THIS DOES NOT LOG FOOD ON ANYONE'S BEHALF ────────────────────────────────
//
// The app never decides that a serving happened. What regularity buys is SPEED: the
// two groups someone logs nearly every morning, tapped 1.4 seconds apart, become one
// tap instead of two. The user still makes that tap, on a button whose label names
// every group it will write. Nothing here runs on a schedule, from a nudge, or from
// any surface the user did not open.
//
// ── THE OFFER IS RENDERED FROM STATE, AND SO IS THE WRITE ────────────────────
//
// `getUsualFoodOffer` (lib/queries/nutrition.ts) decides what the button says; this
// core calls the SAME function again against fresh server state and writes only the
// INTERSECTION of that answer with the keys the button actually named. Two properties
// follow, and both matter:
//
//   • it can never write a superset of what the label promised — a forged or replayed
//     form naming the whole catalog lands nothing outside the current offer;
//   • it can never write a group the offer no longer justifies — a page left open
//     while breakfast was logged from Telegram writes the remainder, or refuses.
//
// That is the stateful-affordance contract (docs/internals/stateful-affordances.md)
// applied to an offer over an ADDITIVE store: `food_log` is deliberately not a gated
// stateful table (a second serving is a second serving), so the discipline lives in
// the offer rather than in the counter, and a stale tap lands on an honest typed
// refusal instead of a silent second breakfast.
//
// ── ALWAYS TODAY ─────────────────────────────────────────────────────────────
//
// The date is the profile's own today, resolved HERE, and no date crosses the wire.
// Regularity is derived from the ledger, so an offer that could bulk-backfill days
// nobody remembers would feed its own evidence back into itself. "One tap for the
// thing you log every day" is a claim about the day you are living.

import { instantNow } from "./clock";
import { today, writeTx } from "./db";
import { logFoodServingCore } from "./food-log-write";
import type { FoodSlot } from "./food-slot";
import { getUsualFoodOffer } from "./queries/nutrition";

// One group the tap actually logged, with the server's authoritative counts for it —
// the day total and the total inside the window, the same pair a single serving tap
// answers with (#748 item 2), so the bar adopts server truth rather than its guess.
export interface UsualFoodLogged {
  groupKey: string;
  servings: number;
  mealServings: number;
}

// nothing-to-log — the offer the tap came from no longer stands: every named group is
// already logged in that window today, or none of them is habitual any more. Nothing
// was written and the surface must say so rather than confirm.
export type UsualFoodOutcome =
  | {
      kind: "logged";
      date: string;
      window: FoodSlot;
      groups: UsualFoodLogged[];
    }
  | { kind: "nothing-to-log" };

// A serving write refused PART-WAY THROUGH the set — thrown, never returned, and
// caught immediately outside `writeTx` below.
//
// WHY A THROW IS THE ONLY CORRECT SHAPE HERE. `writeTx` is
// `db.transaction(fn).immediate()` (lib/db.ts), and better-sqlite3 COMMITS on a normal
// return; it rolls back only on a throw. So `return { kind: "nothing-to-log" }` from
// inside the loop would commit the servings already written while telling the caller
// nothing was — the exact half-written set the atomicity comment below forbids, and
// worse than silent: the bar would re-render from server state, the offer would shrink,
// and the user would be looking at a breakfast they had just been told was not logged.
//
// The sentinel keeps `UsualFoodOutcome` unchanged (this is not a new public state —
// a set that could not be written whole IS "nothing was logged", and now truthfully).
// Letting it propagate as a 500 was the alternative; it is rejected because the caller
// already renders `nothing-to-log` honestly and a refusal here is a legitimate,
// answerable outcome rather than a server fault.
//
// DO NOT turn this back into a `return`.
class UsualFoodRefused extends Error {}

// Log one serving of each still-offered usual group into `window` on the profile's
// today. ONE transaction for the whole set: the offer is a single user intent, so it
// lands whole or not at all — a partial write would leave the bar showing a set the
// user never chose. `logFoodServingCore`'s own writeTx becomes a SAVEPOINT inside this
// one (lib/db.ts), so every serving still goes through the one counter+ledger path
// rather than a second spelling of it, and the outer rollback discards those savepoints
// with everything else.
export function logUsualFoodCore(
  profileId: number,
  window: FoodSlot,
  // The group keys the button NAMED. Authoritative only as an upper bound: the offer
  // re-derived below decides what is actually written.
  named: readonly string[],
  loggedAt: string = instantNow()
): UsualFoodOutcome {
  const date = today(profileId);
  try {
    return writeTx(() => {
      const offered = new Set(getUsualFoodOffer(profileId, window, date));
      // Order follows the button's, so the toast reads back what the user tapped.
      const toLog = named.filter((groupKey) => offered.has(groupKey));
      // A plain RETURN is correct here and only here: nothing has been written yet, so
      // committing an empty transaction and reporting "nothing to log" are the same
      // fact. Below, where servings already exist, the same shape would be a bug —
      // see UsualFoodRefused.
      if (toLog.length === 0) return { kind: "nothing-to-log" };

      const groups: UsualFoodLogged[] = [];
      for (const groupKey of toLog) {
        // The window is a DECLARATION here, exactly as the bar's meal tab is (#2269):
        // the offer is about a meal window and states no eating time, so the serving
        // carries the declared slot and a NULL eating instant rather than a guessed one.
        const outcome = logFoodServingCore(
          profileId,
          groupKey,
          date,
          loggedAt,
          window
        );
        // Unreachable in practice — the offer only ever contains catalog slugs — but a
        // refusal must not be swallowed into a half-written set, so it THROWS to reach
        // the rollback rather than returning past the servings already written.
        if (outcome.kind !== "logged") throw new UsualFoodRefused();
        groups.push({
          groupKey,
          servings: outcome.servings,
          mealServings: outcome.mealServings ?? 0,
        });
      }
      return { kind: "logged", date, window, groups };
    });
  } catch (error) {
    // Only OUR sentinel is an outcome; every other failure (a locked database, a
    // constraint violation) is still a fault and must keep propagating.
    if (error instanceof UsualFoodRefused) return { kind: "nothing-to-log" };
    throw error;
  }
}
