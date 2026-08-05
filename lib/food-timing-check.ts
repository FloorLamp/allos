// THE DECLARED FOOD TIMING, CHECKED AGAINST THE LEDGER (issue #2022) — the pure half.
//
// Every dose declares a `food_timing`, and the reminder has always rendered it as a
// STATIC LABEL: an 08:00 `with_food` reminder says "with food" into a morning where
// nothing has been logged, even though the app holds both the declaration and the food
// ledger and could simply compare them. This module is that comparison.
//
// ── WHAT IT IS, AND WHAT IT IS NOT ───────────────────────────────────────────
//
// One optional, INFORMATIONAL clause riding a send that already fires. It never gates
// a reminder, never delays one, never escalates and never suppresses: a dose reminder
// is a safety signal, so the ledger may inform its text and nothing else. The dose
// stays due either way and `markDoseTaken` is untouched — the same posture as the
// weather-med notes (#1727).
//
// ── WHY IT IS PHRASED ABOUT THE LOG, NEVER ABOUT THE PERSON ──────────────────
//
// Absence of a food log is WEAK EVIDENCE. Somebody may have eaten a full breakfast and
// logged none of it, so "you haven't eaten" would be a claim the app cannot support,
// while "no food logged" is exactly what it knows. That is the honest-coverage
// discipline in one sentence, and it is why the two clauses below name the LEDGER as
// their subject rather than the human.
//
// ── WHY COARSE RECENCY IS ENOUGH HERE ────────────────────────────────────────
//
// The question is about RIGHT NOW and the answer is consumed immediately, not
// reconstructed later — the same reason a tap instant is a poor basis for history and
// a fine basis for the present. So a trailing window over the ledger's most recent
// serving is the whole computation. When a serving carries a STATED eating instant
// (#2019's `eaten_at`) that instant wins over the tap stamp, which is the only place
// this feature needed to know #2019 exists.
//
// NO DB, NO CLOCK — the caller reads the ledger and passes minutes — so the truth
// table is fixture-testable (lib/__tests__/food-timing-check.test.ts).

import type { FoodTiming } from "./types/intake";

// A serving logged within this many minutes counts as "recent food" for a dose that
// wants to be taken WITH food. Generous on purpose: the failure mode of a too-tight
// window is telling somebody nothing is logged minutes after they logged breakfast,
// which teaches them to ignore the clause.
export const WITH_FOOD_RECENT_MIN = 90;

// A serving logged within this many minutes is worth NAMING to a dose that wants an
// empty stomach. Tighter than the with-food window because the two clauses answer
// different questions: "has eating happened at all lately" versus "is eating recent
// enough that this dose's separation is probably not met".
export const EMPTY_STOMACH_RECENT_MIN = 60;

// How far back a reader has to look to answer either question. Exported so the query
// layer's lookback and this module's windows can never drift apart.
export const FOOD_CHECK_LOOKBACK_MIN = Math.max(
  WITH_FOOD_RECENT_MIN,
  EMPTY_STOMACH_RECENT_MIN
);

// Below this the clause says "just now" rather than a rounded figure: "~0 min ago" and
// "~5 min ago" are both worse answers than the words.
const JUST_NOW_MIN = 5;

// The check's three outcomes. `none` is the overwhelmingly common one — an `any` dose,
// or a declaration the ledger currently agrees with — and renders nothing at all,
// because a clause that appears on every line is a clause nobody reads.
export type FoodTimingCheck =
  // Nothing to say.
  | { kind: "none" }
  // Declared with food / with fat, and the ledger holds no recent serving.
  | { kind: "nothing-logged" }
  // Declared empty stomach / before a meal, and the ledger holds a recent serving.
  | { kind: "food-logged"; minutesAgo: number };

export const NO_CHECK: FoodTimingCheck = { kind: "none" };

// The predicate, over the five declared timings × the ledger's most recent serving.
//
// `minutesSinceServing` is minutes since the most recent serving's EATING instant
// (its stated `eaten_at` when it has one, else its tap stamp), or null when the ledger
// holds none in the lookback window. A negative value — a stated instant slightly
// ahead of the caller's now — is read as "just now" rather than being rejected: the
// user said they ate, and arguing with them about seconds would be the wrong answer.
export function foodTimingCheck(
  timing: FoodTiming,
  minutesSinceServing: number | null
): FoodTimingCheck {
  const since =
    minutesSinceServing == null || !Number.isFinite(minutesSinceServing)
      ? null
      : Math.max(0, minutesSinceServing);
  switch (timing) {
    // "with or without food" declares nothing, so there is nothing to check. This row
    // of the table is the one that must NEVER render — it is the default for most
    // doses, and a clause on every line would drown the ones that mean something.
    case "any":
      return NO_CHECK;
    case "with_food":
    case "with_fat":
      return since !== null && since <= WITH_FOOD_RECENT_MIN
        ? NO_CHECK
        : { kind: "nothing-logged" };
    case "empty_stomach":
    case "before_meal":
      return since !== null && since <= EMPTY_STOMACH_RECENT_MIN
        ? { kind: "food-logged", minutesAgo: since }
        : NO_CHECK;
  }
}

// "just now" / "~20 min ago" — the recency, rounded to five minutes so the clause
// cannot imply a precision the ledger does not have (a tap instant is a measurement
// with error, and a stated one is answered to the hour).
export function foodRecencyPhrase(minutesAgo: number): string {
  if (minutesAgo < JUST_NOW_MIN) return "just now";
  return `~${Math.round(minutesAgo / JUST_NOW_MIN) * JUST_NOW_MIN} min ago`;
}

// The rendered clause, or "" when there is nothing to say. ONE formatter for every
// surface that renders a dose reminder, so the dedicated reminder and a merged
// multi-slot send can never word the same fact differently (#221).
//
// Both strings name the LOG. The first also names its own window, because "nothing
// logged" without a horizon would read as a claim about the whole day — which is
// exactly the overstatement the honest phrasing exists to avoid.
export function foodTimingCheckNote(check: FoodTimingCheck): string {
  switch (check.kind) {
    case "none":
      return "";
    case "nothing-logged":
      return `no food logged in the last ${WITH_FOOD_RECENT_MIN} min`;
    case "food-logged":
      return `food logged ${foodRecencyPhrase(check.minutesAgo)}`;
  }
}
