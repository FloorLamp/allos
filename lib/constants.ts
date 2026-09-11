// POLICY NUMERALS, IN ONE PLACE (issue #4243).
//
// A policy numeral is a number the app CHOSE: a window length, a rate, a ratio, a
// floor, a cap. It is not arithmetic (a 7 that means "days in a week", a 100 that
// turns a fraction into a percent) and it is not a unit conversion — those stay
// where they are used. What lands here is the kind of number a future decision
// re-tunes, and that had been written down in more than one place.
//
// ── LOCATION, NOT VALUE-UNIFICATION ──────────────────────────────────────────
// Two policies that happen to share a value stay TWO declarations with two names
// and two reasons. The unrelated 90-day windows are five names on purpose, and
// this file records that they are unrelated rather than merging them. The only
// thing being removed is a number written twice for ONE question.
//
// ── COPY FORMATS FROM THE CONSTANT ───────────────────────────────────────────
// Where a sentence states a threshold ("~10%", "~1%/week"), the sentence is built
// from the constant via `policyPercent` below, so re-tuning the number cannot
// leave the prose behind.
//
// ── DEPENDENCY-LIGHT, DELIBERATELY ───────────────────────────────────────────
// This module imports NOTHING. Client and server code both read it, so an import
// here must never be able to pull a server-only module (a DB handle, node:fs)
// into a client bundle. A constant whose declaration would need an import stays
// in its own module and is re-exported from there instead.
//
// Each group below is a domain; each declaration carries the one line that says
// why the number is what it is (the `DEFAULT_COACHING_THRESHOLDS` style,
// lib/coaching/engine.ts).

// ---- Strength coaching: the deload week (#741, #1203) ----

// A deload week's load multiplier — ~10% lighter, a fixed conservative lever
// rather than a fatigue model. The plateau advice states the same magnitude as
// prose and formats it from HERE, so the number and the sentence cannot desync.
export const DELOAD_LOAD_FACTOR = 0.9;

// ---- Body goals: safe weight-loss pace (#2962) ----

// Sustained loss faster than this fraction of body weight PER WEEK trips the
// gentle caution — ~1%/week is the widely-cited ceiling for preserving lean mass
// during a cut. The caution's copy names the same figure and formats it from HERE.
export const SAFE_LOSS_FRACTION_PER_WEEK = 0.01;

// ---- Intake adherence: the rolling window (#1936) ----

// How many days of daily states an item's recent adherence is summarized over —
// two weeks, long enough to read as "lately" and short enough that a fixed habit
// shows up. Every adherence surface spends the same window: the per-item strip,
// and the notification that decides an item is being missed.
export const ADHERENCE_WINDOW_DAYS = 14;

// ---- Formatting a policy numeral into copy ----

/**
 * A policy fraction as the percent a sentence says: 0.01 → "1%", 0.9's 10% drop
 * → "10%". Rounded to one decimal, which both absorbs float noise (1 − 0.9 is
 * 0.09999999999999998) and keeps a half-percent threshold readable if one is ever
 * introduced. Trailing ".0" never appears, because "1.0%/week" is not how a
 * sentence says it.
 */
export function policyPercent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}
