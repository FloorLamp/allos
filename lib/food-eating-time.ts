// EATING-TIME CAPTURE ON THE WEB FOOD BAR (issue #2053, from #2019 §2) — the pure half.
//
// ── WHY THE WEB BAR NEEDED ITS OWN VOCABULARY ────────────────────────────────
//
// The Telegram food button carries a contract — "I'm eating NOW" — so its tap instant IS
// a measurement, and #2052 records it as `occurred_at` with `time_source = 'tap'`. The web
// bar's "+" carries no such contract: the same button logs the apple in your hand and
// backfills Sunday's dinner from a bounded seven-day picker. Defaulting it to now would
// reintroduce the guess `occurred_at` exists to end, under a more authoritative name, so an
// unstated web log keeps a NULL eating time and always will.
//
// This module is the EXPLICIT statement that overrides that silence: an absolute local
// wall time the person picked and can see. It is a human answer, so it writes
// `time_source = 'stated'`. There is no second state that guesses.
//
// ── WHY THE OFFER IS ABSOLUTE HOURS, NOT "−2h" OR "now" ──────────────────────
//
// The same reason the correction picker is (lib/correction-time.ts): a relative offset is
// computed at TAP time, so someone who takes two minutes to decide lands two minutes off,
// and a page open since breakfast would offer a "−2h" meaning something different every
// minute. "13:00" cannot drift. It also survives the one thing a rendered page does that
// a chat keyboard does not — sit untouched for an hour — because an absolute past hour
// resolves to the same instant however stale the render is, right up until local midnight.
//
// "now" WAS the exception and is gone (#3273). The bar used to post the WORD, resolved
// against the server's clock, beside a hand-rolled hour-chip group — two vocabularies for
// one question, in a file whose own correction modal already asked it through
// `WhenControl`. The shared control's one-tap "Now" fills an absolute local time INTO the
// field, so what will be written is on screen and adjustable (its invariant 3) instead of
// being a word the server expands later. One offer, one wire shape: "HH:MM".
//
// ── WHY EVERY PATH VALIDATES, AND NONE OF THEM DROPS ─────────────────────────
//
// `judgeEatenAt` is the one gate, and it is `resolveQueuedTakenAt`'s posture applied to
// eating time: an unusable instant costs the STATEMENT, never the serving. Losing the
// stated minute is cosmetic; refusing the tap would be a lost food log. The rule itself
// — not meaningfully in the future, and its profile-local date IS the row's own `date` —
// turned out not to be about food at all, so it lives in lib/stated-time.ts (#2236) as
// `judgeStatedAt` and is re-exported here under its food name: one computation, worn by
// every surface that records when an observed event happened. What stays genuinely food
// is the ENRICHMENT below — an offered hour carries the meal window it files under, which
// is a fact no other domain's "when" has.
//
// NEVER DROPS also means NEVER SILENTLY (#2296): the gate answers a VERDICT, so the
// serving still lands and the surface still gets to say the minute went missing and why.
//
// NO DB, NO AMBIENT CLOCK — every function takes its `now`.

import { statedHoursOnDate } from "./stated-time";
import {
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";

export {
  judgeStatedAt as judgeEatenAt,
  STATED_FUTURE_SKEW_MS as EATEN_AT_FUTURE_SKEW_MS,
} from "./stated-time";

// ---- The CORRECTION sheet's offer (#2227) ----

// One offered hour of the correction sheet's selected day: the neutral day-hours
// option (lib/stated-time.ts) plus the meal window that hour derives to under the
// profile's own boundaries — the data #2227 decision 4 runs on, where the sheet's
// Meal select follows the chosen hour until Meal is touched by hand.
export interface EatingHourOption {
  hhmm: string;
  iso: string;
  slot: FoodSlot;
}

// The hours of `date` a serving may be stated to have been eaten at, each carrying the
// instant it means and its derived meal window. This is `statedHoursOnDate` (#2236,
// born there as #2227's proposed `eatingHoursOnDate`) wearing the one genuinely-food
// enrichment: the slot. The offer itself stays the neutral module's — truncated at the
// current local hour when `date` is today, DST-safe, every option acceptable to
// `judgeEatenAt` by construction. The hour is an hour OF a day the sheet has already
// named, so there is no cross-midnight re-dating on this surface: the day field owns
// the day.
export function eatingHoursOnDate(
  date: string,
  tz: string,
  now: Date,
  boundaries: FoodSlotBoundaries
): EatingHourOption[] {
  return statedHoursOnDate(date, tz, now).map((option) => ({
    ...option,
    slot: foodSlotForHhmm(option.hhmm, boundaries),
  }));
}

// `judgeEatenAt` — the verdict on the eating instant a serving should actually carry —
// is re-exported at the top of this module from lib/stated-time.ts (`judgeStatedAt`,
// #2236). The VALIDATE-NEVER-DROP posture of the log path stays a fact about the
// CALLERS, not the rule: a `refused` verdict costs the statement, never the serving,
// while the correction path (#2227) treats the same verdict as an error the user sees.
// Since #2296 BOTH tell the user — the log path as a notice on a write that succeeded,
// the correction path as the failure it genuinely is.
//
// `now` is injected because the rule is PURE, not because the clock is a per-caller
// taste. Every caller — the online action, the correction path and the offline replay
// — judges against the app's own clock seam (`clockNow()`). #2287 settled that: the
// replay used to pass a bare `new Date()`, on the reasoning that a client instant is
// off an independent REAL clock. It is not independent — under the e2e freeze the
// BROWSER is put on the same frozen clock the server reads, so a statement resolved
// against the seam was being refused as "in the future" by a now that was not the
// seam's. Validating an untrusted instant is still right; validating it against a
// different clock than the one that produced it never was.
//
// The two changes are complements, and the order matters: #2287 removes the SPURIOUS
// refusals (a clock the app itself moved), #2296 makes the ones that remain — a
// genuinely fast device clock, a statement on another day — audible instead of silent.
