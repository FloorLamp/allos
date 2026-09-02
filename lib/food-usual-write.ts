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
// applied to an offer over an ADDITIVE store: `food_daily_totals` is deliberately not a gated
// stateful table (a second serving is a second serving), so the discipline lives in
// the offer rather than in the counter, and a stale tap lands on an honest typed
// refusal instead of a silent second breakfast.
//
// ── THE DATE IS THE CALLER'S, AND THE EVIDENCE GUARD IS WHY THAT IS SAFE ─────
//
// This core used to resolve `today(profileId)` itself and refuse to be told a day at
// all. The reason was never that a past day is unknowable — a person who ate their
// usual breakfast on Tuesday and logged nothing is the commonest thing in this ledger
// — it was SELF-EVIDENCE: "usual" is derived from `getFoodRegularity`, so a bundle
// written onto days nobody remembers would become the reason it is offered again.
// Three backfilled mornings would manufacture the fourth.
//
// #4118 keeps that intent and moves it to where it actually bites. A bundle aimed at a
// day that is not the profile's today is stamped `USUAL_BACKFILL` instead of its
// surface, and `getFoodRegularity` excludes exactly that stamp from its evidence
// window. So the loop is cut at the READ, not at the write: the rows count everywhere
// a person looks — the day view, the tallies, the ledgers, adherence — and count for
// nothing in the measure that decides what "usual" means. A contemporaneous tap is
// untouched: same stamp it always had, same evidence it always was.
//
// The reach is bounded by `isUsualBackfillDateAccepted` (today and the six days
// before, the nutrition day picker's own span). Further back is the `/history` door's
// per-item business, because reconstructing a fortnight is not one tap's worth of
// remembering.

import { instantNow } from "./clock";
import { USUAL_BACKFILL, type LoggedVia } from "./logged-via";
import { today, writeTx } from "./db";
import {
  logFoodServingCore,
  type FoodEatingTime,
  type FoodWriteOrigin,
} from "./food-log-write";
import { isUsualBackfillDateAccepted } from "./food-regularity";
import { isProteinNudgeKey } from "./protein-nudge";
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
//
// invalid-date — the target day is malformed, in the future, or further back than the
// bundle may reach (#4118). A DIFFERENT answer from `nothing-to-log`, because "there is
// nothing left to write" and "you may not write there" are different facts and the
// surface says different things about them.
export type UsualFoodOutcome =
  | {
      kind: "logged";
      date: string;
      window: FoodSlot;
      groups: UsualFoodLogged[];
    }
  | { kind: "nothing-to-log" }
  | { kind: "invalid-date" };

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

// Log one serving of each still-offered usual group into `window` on `date`. ONE
// transaction for the whole set: the offer is a single user intent, so it
// lands whole or not at all — a partial write would leave the bar showing a set the
// user never chose. `logFoodServingCore`'s own writeTx becomes a SAVEPOINT inside this
// one (lib/db.ts), so every serving still goes through the one counter+ledger path
// rather than a second spelling of it, and the outer rollback discards those savepoints
// with everything else.
export function logUsualFoodCore(
  profileId: number,
  window: FoodSlot,
  // WHICH DAY (#4118). Required, no default: a core that resolved its own today would
  // be a core a dated call site could land on the wrong day without noticing, which is
  // the same reason `loggedVia` below takes no default. Bounded here, never by the
  // caller's markup.
  date: string,
  // The group keys the button NAMED. Authoritative only as an upper bound: the offer
  // re-derived below decides what is actually written.
  named: readonly string[],
  // Which surface tapped the usual-routine button (#3087) — the dashboard control, the
  // Nutrition page's own, or the composed Telegram one-tap. Required, no default.
  loggedVia: LoggedVia,
  loggedAt: string = instantNow(),
  // WHEN THE BUNDLE WAS EATEN (#4438), when the tap stated one. Every row the bundle
  // writes carries it, because one tap is one physical event. Absent keeps the declared
  // meal window and a NULL eating instant, which is what a backfill with nothing stated
  // honestly holds.
  time?: FoodEatingTime,
  // Which message's tap this is (#2264/#2460) — the Telegram composed one-tap only;
  // the web control passes nothing and stores NULL, exactly as the bar does.
  origin?: FoodWriteOrigin
): UsualFoodOutcome {
  const t = today(profileId);
  if (!isUsualBackfillDateAccepted(t, date)) return { kind: "invalid-date" };
  // The provenance the evidence guard keys on. Decided HERE from the day, never posted:
  // a surface cannot claim a backfill it is not doing, and cannot dress a backfill up as
  // contemporaneous evidence either.
  const via = date === t ? loggedVia : USUAL_BACKFILL;
  try {
    return writeTx(() => {
      const offered = new Set(getUsualFoodOffer(profileId, window, date));
      // Order follows the button's, so the toast reads back what the user tapped.
      //
      // THE RESERVED PROTEIN KEY IS A MEMBER OF THE OFFER AND NOT OF THIS LOOP (#4379).
      // It earns its place through the same measure as any group, so `offered` names it
      // — but `logFoodServingCore` refuses a non-catalog slug, and a refusal in here
      // THROWS to the rollback, so leaving it in would let a protein habit take the
      // whole breakfast down with it. `logUsualRoutineCore` writes the grams through
      // `addProteinGramsCore`, the one protein write path (#221), as a sibling of this
      // transaction exactly as the dose half is.
      const toLog = named.filter(
        (groupKey) => offered.has(groupKey) && !isProteinNudgeKey(groupKey)
      );
      // A plain RETURN is correct here and only here: nothing has been written yet, so
      // committing an empty transaction and reporting "nothing to log" are the same
      // fact. Below, where servings already exist, the same shape would be a bug —
      // see UsualFoodRefused.
      if (toLog.length === 0) return { kind: "nothing-to-log" };

      const groups: UsualFoodLogged[] = [];
      for (const groupKey of toLog) {
        // The window is a DECLARATION here when nothing was stated, exactly as the bar's
        // meal tab is (#2269). WHEN A TIME IS STATED the serving carries it and
        // `logFoodServingCore`'s one chokepoint derives the window from the instant —
        // the same rule the single-serving tap beside this one has always obeyed, and
        // the reason the statement is threaded rather than dropped (#4438).
        const outcome = logFoodServingCore(
          profileId,
          groupKey,
          date,
          via,
          loggedAt,
          window,
          time,
          origin
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
