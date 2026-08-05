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
// stated minute is cosmetic; refusing the tap would be a lost food log. It enforces the
// two rules that keep a row from contradicting itself — not meaningfully in the future,
// and its profile-local date IS the row's own `date` — because `eaten_at` is what the slot
// derivation and the cross-midnight re-date read, so an instant sitting outside its own
// day is not a correction, it is corruption.
//
// NO DB, NO AMBIENT CLOCK — every function takes its `now`.

import { dateStrInTz } from "./date";
import { hourOptionsBack, statedHourInstant } from "./correction-time";

// How far back the "earlier…" offer reaches. Twelve hours covers the case the affordance
// exists for — this morning's breakfast entered at lunchtime — and stops well short of
// the point where somebody should be using the day picker instead.
export const EATING_TIME_FIRST_HOURS_BACK = 1;
export const EATING_TIME_LAST_HOURS_BACK = 12;

// Tolerated clock difference between a client and the server before a stated instant
// reads as future. Matches the dose given_at guard's tolerance for the same reason: a
// genuinely future eating time is a forgery or a broken clock, but five minutes of skew
// is neither.
export const EATEN_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

// What the user said about when a serving was eaten. `null` — the default and the common
// case — is "nobody said", which stays a real answer rather than being filled in.
export type EatingTimeChoice = { kind: "now" } | { kind: "at"; hhmm: string };

// One offered "earlier…" hour: the local wall time the chip shows, and the instant it
// means. Both are resolved SERVER-SIDE from the profile's timezone, so the browser never
// has to convert a profile-local hour with its own locale — and the instant is what an
// offline capture carries into replay, where there is no server to ask.
export interface EatingTimeOption {
  hhmm: string;
  iso: string;
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
): Date {
  return choice.kind === "now"
    ? new Date(now.getTime())
    : statedHourInstant(choice.hhmm, now, tz);
}

// The hours the "earlier…" affordance offers, newest first, each with the instant it
// resolves to — filtered to those that land on `date`, the day the serving is being
// logged to. That filter is what makes the offer honest rather than merely validated:
// shortly after midnight the twelve-hour reach would otherwise mostly point at yesterday,
// and a chip that `acceptEatenAt` would refuse should never have been on screen.
export function eatingTimeOptions(
  now: Date,
  tz: string,
  date: string
): EatingTimeOption[] {
  const out: EatingTimeOption[] = [];
  for (const hhmm of hourOptionsBack(
    now,
    tz,
    EATING_TIME_FIRST_HOURS_BACK,
    EATING_TIME_LAST_HOURS_BACK
  )) {
    const instant = statedHourInstant(hhmm, now, tz);
    if (dateStrInTz(tz, instant) !== date) continue;
    out.push({ hhmm, iso: instant.toISOString() });
  }
  return out;
}

// The eating instant a serving should actually carry, or null meaning "record no eating
// time" — never "refuse the serving". VALIDATE, NEVER DROP (the `resolveQueuedTakenAt`
// discipline): losing the stated minute is cosmetic, losing the food log is not.
//
// Two rules, and the second is the load-bearing one: the instant's profile-local date
// must BE the row's `date`. `eaten_at` is what the meal-window derivation and the
// cross-midnight re-date read, so an instant outside its own row's day would make the
// serving disagree with itself.
//
// `now` is injected and its clock is the CALLER'S choice, deliberately: the online action
// resolves the choice against the app's own clock seam and is comparing that seam with
// itself, while the offline replay is judging an instant that came off an untrusted
// CLIENT wall clock and therefore compares against real time — the same seam distinction
// `resolveQueuedTakenAt` documents at length.
export function acceptEatenAt(
  eatenAt: Date | null | undefined,
  tz: string,
  date: string,
  now: Date
): Date | null {
  if (!eatenAt || Number.isNaN(eatenAt.getTime())) return null;
  if (eatenAt.getTime() > now.getTime() + EATEN_AT_FUTURE_SKEW_MS) return null;
  return dateStrInTz(tz, eatenAt) === date ? eatenAt : null;
}
