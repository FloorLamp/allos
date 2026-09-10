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

import {
  statedHoursOnDate,
  statedInstantOnDate,
  type StatedTimeVerdict,
} from "./stated-time";
import { statedHourInstant } from "./correction-time";
import { dateStrInTz, utcInstant, zonedWallTimeToUtc } from "./date";
import { normalizeClockTime } from "./vitals-input";
import type { FoodPlacement } from "./food-log-write";
import {
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";

import {
  judgeStatedAt as judgeEatenAt,
  STATED_FUTURE_SKEW_MS as EATEN_AT_FUTURE_SKEW_MS,
} from "./stated-time";

export { judgeEatenAt, EATEN_AT_FUTURE_SKEW_MS };

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

// ---- The POSTED statement, judged (#4438) ----

// The verdict on the wall time a web form posted about a serving, for the row's own
// `date`. Both food write paths ask it — the single-serving add and the composed usual
// bundle — so the two cannot answer "what did they say, and may we keep it" differently
// for the same field on the same bar.
//
// The wire shape is an ABSOLUTE profile-local "HH:MM" and never a client instant: the
// server resolves it against its own clock and the profile's timezone, so no browser
// converts a profile-local hour with its own locale. An absent or unusable statement
// records NO eating time — the validate-never-drop rule — and the VERDICT is what lets
// the caller tell the user the minute went missing instead of dropping it in silence
// (#2296).
//
// WHICH DAY A BARE WALL TIME MEANS, and the two cases are genuinely different.
//
//   THE ROW'S DAY IS TODAY — THE DAY RULE, with the acceptance gate's own clock
//   tolerance, as it has been since #3273 moved the offer client-side.
//   `statedHourInstant` reads a wall time later than `now` as YESTERDAY's: right for a
//   picker whose hours the server enumerated, wrong for a field the browser filled from
//   its own clock, so the skew rides along. Measured: a 90-second skew re-dated the
//   statement and lost it. The re-dating is what keeps the caller's backfill guard
//   non-vacuous for the today case.
//
//   THE ROW'S DAY IS A PAST DAY — ANCHORED ON THAT DAY, by construction (#4118's
//   past-day amendment). The form NAMES its day, the surface offered that day's own
//   hours, and `statedInstantOnDate` enforces the (date, hhmm) pair or refuses: a wall
//   time that does not exist there (a spring-forward gap) comes back null and is
//   reported as malformed rather than settling silently onto a different reading.
//   Re-dating relative to `now` here is simply wrong — "8pm" stated about last Tuesday
//   is last Tuesday's, and the day rule would resolve it to today or yesterday and then
//   refuse it as "not on that day", which is how the amendment's sticky-time batch would
//   have silently lost every minute it set. This is the same split `offeredHourInstant`
//   already makes between its `today` and `prev` levels.
//
// THE REFUSAL IS RIGHT; ITS REASON WAS NOT. Past the tolerance a fast clock's wall time
// re-dates to yesterday and is refused for missing the row's day — correct to refuse,
// and re-anchoring on the row's date instead would make the backfill guard vacuous. But
// "it isn't on that day" is untrue when the day is the one the person is standing in,
// and it blames the wrong machine. Same outcome, and the reason the queued path already
// reports for this. Both conditions carry weight: `aheadOfServer` separates a fast clock
// from an hour genuinely meant as yesterday's, and the row's date being today is what
// makes "that day" theirs — a real backfill off its day is still told so.
export function judgePostedEatingTime(
  posted: unknown,
  date: string,
  tz: string,
  now: Date
): StatedTimeVerdict {
  const stated = normalizeClockTime(String(posted ?? ""));
  if (!stated) return { kind: "unstated" };
  const localToday = dateStrInTz(tz, now);
  const resolved =
    date === localToday
      ? statedHourInstant(stated, now, tz, EATEN_AT_FUTURE_SKEW_MS)
      : statedInstantOnDate(date, stated, tz);
  const judged: StatedTimeVerdict =
    resolved === null
      ? { kind: "refused", reason: "malformed" }
      : judgeEatenAt(resolved, tz, date, now);
  if (judged.kind !== "refused" || judged.reason !== "other-day") return judged;
  const onToday = zonedWallTimeToUtc(tz, localToday, stated);
  const aheadOfServer =
    onToday !== null &&
    onToday.getTime() > now.getTime() + EATEN_AT_FUTURE_SKEW_MS;
  return aheadOfServer && date === localToday
    ? { kind: "refused", reason: "future" }
    : judged;
}

// The placement a judged statement makes, or the tab's declaration when nobody stated a
// time and when the one they stated could not be kept. #4729's one-placement rule
// reduced at the boundary that can still see the gesture: 'stated' for a human answer
// ("now" and "13:00" are equally one), never the Telegram button's 'tap'.
export function statedFoodPlacement<T extends FoodSlot | undefined>(
  verdict: StatedTimeVerdict,
  declared: T
): FoodPlacement | T {
  return verdict.kind === "accepted"
    ? { eatenAt: utcInstant(verdict.at), source: "stated" }
    : declared;
}
