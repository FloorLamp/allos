// EATING-TIME CAPTURE ON THE WEB FOOD BAR (issue #2053, from #2019 §2) — the pure half.
//
// ── WHY THE WEB BAR NEEDED ITS OWN VOCABULARY ────────────────────────────────
//
// The Telegram food button carries a contract — "I'm eating NOW" — so its tap instant IS
// a measurement, and #2052 records it as `eaten_at` with `time_source = 'tap'`. The web
// bar's "+" carries no such contract: the same button logs the apple in your hand and
// backfills Sunday's dinner from a bounded seven-day picker. Defaulting it to now would
// reintroduce the guess `eaten_at` exists to end, under a more authoritative name, so an
// unstated web log keeps a NULL eating time and always will.
//
// This module is the EXPLICIT statement that overrides that silence: "now", or one of the
// recent absolute local hours. Either is a human answer, so either writes
// `time_source = 'stated'`. There is no third state that guesses.
//
// ── WHY THE OFFER IS ABSOLUTE HOURS, NOT "−2h" ───────────────────────────────
//
// The same reason the correction picker is (lib/correction-time.ts): a relative offset is
// computed at TAP time, so someone who takes two minutes to decide lands two minutes off,
// and a page open since breakfast would offer a "−2h" meaning something different every
// minute. "13:00" cannot drift. It also survives the one thing a rendered page does that
// a chat keyboard does not — sit untouched for an hour — because an absolute past hour
// resolves to the same instant however stale the render is, right up until local midnight.
//
// ── WHY EVERY PATH VALIDATES, AND NONE OF THEM DROPS ─────────────────────────
//
// `acceptEatenAt` is the one gate, and it is `resolveQueuedTakenAt`'s posture applied to
// eating time: an unusable instant costs the STATEMENT, never the serving. Losing the
// stated minute is cosmetic; refusing the tap would be a lost food log. The rule itself
// — not meaningfully in the future, and its profile-local date IS the row's own `date` —
// turned out not to be about food at all, so it lives in lib/stated-time.ts (#2236) as
// `acceptStatedAt` and is re-exported here under its food name: one computation, worn by
// every surface that records when an observed event happened. What stays genuinely food
// is the #2053 reach-back-from-now offer below — a LOG-time question no other surface
// asks, because only at log time is the day implicit.
//
// NO DB, NO AMBIENT CLOCK — every function takes its `now`.

import { dateStrInTz } from "./date";
import { hourOptionsBack, statedHourInstant } from "./correction-time";
import { statedHoursOnDate } from "./stated-time";
import {
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "./food-slot";

export {
  acceptStatedAt as acceptEatenAt,
  STATED_FUTURE_SKEW_MS as EATEN_AT_FUTURE_SKEW_MS,
} from "./stated-time";

// How far back the "earlier…" offer reaches. Twelve hours covers the case the affordance
// exists for — this morning's breakfast entered at lunchtime — and stops well short of
// the point where somebody should be using the day picker instead.
export const EATING_TIME_FIRST_HOURS_BACK = 1;
export const EATING_TIME_LAST_HOURS_BACK = 12;

// What the user said about when a serving was eaten. `null` — the default and the common
// case — is "nobody said", which stays a real answer rather than being filled in.
export type EatingTimeChoice = { kind: "now" } | { kind: "at"; hhmm: string };

// One offered "earlier…" hour: the local wall time the chip shows, the instant it
// means, and — since #2269 — the meal window that hour derives to under the profile's
// own boundaries, so the chip ANNOUNCES the filing before the tap (`19:00 · Evening`)
// and the bar can place the serving in its derived section optimistically. All resolved
// SERVER-SIDE from the profile's timezone and boundaries, so the browser never converts
// a profile-local hour with its own locale — and the instant is what an offline capture
// carries into replay, where there is no server to ask. The same enrichment the
// correction sheet's `eatingHoursOnDate` adapter got in #2268, worn by the log-time
// offer: one shape, so the two surfaces cannot drift.
export interface EatingTimeOption {
  hhmm: string;
  iso: string;
  slot: FoodSlot;
}

// The wire spelling of a choice: "now", or "HH:MM". One string on a form field and one
// string in a queued payload, so the online action and the offline replay parse the same
// vocabulary.
export function eatingTimeChoiceValue(choice: EatingTimeChoice): string {
  return choice.kind === "now" ? "now" : choice.hhmm;
}

// Parse a submitted choice. Shape only — WHICH hours are legal depends on the current
// time, which `acceptEatenAt` settles against the resolved instant rather than against a
// list that may have moved since the page rendered.
export function parseEatingTimeChoice(raw: unknown): EatingTimeChoice | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (value === "now") return { kind: "now" };
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? { kind: "at", hhmm: value }
    : null;
}

// Resolve a choice to an instant. "now" is the caller's own now — on the online path that
// is the server's clock, which is the whole point of sending the CHOICE rather than a
// client timestamp. An absolute hour goes through the correction model's day rule, so an
// offered hour later than the current local time means yesterday's, exactly as it does on
// the Telegram picker.
export function resolveEatingTimeChoice(
  choice: EatingTimeChoice,
  now: Date,
  tz: string
): Date | null {
  return choice.kind === "now"
    ? new Date(now.getTime())
    : statedHourInstant(choice.hhmm, now, tz);
}

// The hours the "earlier…" affordance offers, newest first, each with the instant it
// resolves to and the meal window it files under (#2269) — filtered to those that land
// on `date`, the day the serving is being logged to. That filter is what makes the offer
// honest rather than merely validated: shortly after midnight the twelve-hour reach
// would otherwise mostly point at yesterday, and a chip that `acceptEatenAt` would
// refuse should never have been on screen. The slot comes from `foodSlotForHhmm` under
// the caller's boundaries — the SAME derivation the tallies read — so the chip's claim
// and the section the serving lands in cannot disagree.
export function eatingTimeOptions(
  now: Date,
  tz: string,
  date: string,
  boundaries: FoodSlotBoundaries
): EatingTimeOption[] {
  const out: EatingTimeOption[] = [];
  for (const hhmm of hourOptionsBack(
    now,
    tz,
    EATING_TIME_FIRST_HOURS_BACK,
    EATING_TIME_LAST_HOURS_BACK
  )) {
    const instant = statedHourInstant(hhmm, now, tz);
    if (!instant) continue;
    if (dateStrInTz(tz, instant) !== date) continue;
    out.push({
      hhmm,
      iso: instant.toISOString(),
      slot: foodSlotForHhmm(hhmm, boundaries),
    });
  }
  return out;
}

// ---- The CORRECTION sheet's offer (#2227) ----

// One offered hour of the correction sheet's selected day: the neutral day-hours
// option (lib/stated-time.ts) plus the meal window that hour derives to under the
// profile's own boundaries — the data #2227 decision 4 runs on, where the sheet's
// Meal select follows the chosen hour until Meal is touched by hand. Since #2269 the
// log-time offer above carries the same shape, so this is now an alias rather than an
// extension — one vocabulary for "an offered hour and where it files".
export type EatingHourOption = EatingTimeOption;

// The hours of `date` a serving may be stated to have been eaten at, each carrying the
// instant it means and its derived meal window. This is `statedHoursOnDate` (#2236,
// born there as #2227's proposed `eatingHoursOnDate`) wearing the one genuinely-food
// enrichment: the slot. The offer itself stays the neutral module's — truncated at the
// current local hour when `date` is today, DST-safe, every option acceptable to
// `acceptEatenAt` by construction. Unlike `eatingTimeOptions` above (which reaches BACK
// from now, because at log time the day is implicit), this enumerates a day the sheet
// has already named — and the hour is an hour OF that day, so there is no cross-midnight
// re-dating on this surface: the day field owns the day.
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

// `acceptEatenAt` — the eating instant a serving should actually carry, or null meaning
// "record no eating time" — is re-exported at the top of this module from
// lib/stated-time.ts (`acceptStatedAt`, #2236). The VALIDATE-NEVER-DROP posture of the
// log path stays a fact about the CALLERS, not the rule: `null` costs the statement,
// never the serving, while the correction path (#2227) treats the same `null` as a
// refusal the user sees. `now` is injected because the rule is pure, NOT because the
// clock is a per-caller taste: every caller — the online action, the correction path and
// the offline replay — judges against the app's own clock seam (`clockNow()`). #2287
// settled that: the replay used to pass a bare `new Date()`, on the reasoning that a
// client instant is off an independent REAL clock, and the result was a statement
// resolved against the seam being refused as "in the future" by a now that was not the
// seam's. Validating an untrusted instant is still right; validating it against a
// different clock than the one that produced it never was.
