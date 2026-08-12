// "Did a food window close with nothing in it?" (issue #2376) — the pure decision,
// DB-free so it's unit-tested (lib/__tests__).
//
// WHY THIS IS NOT A SEND. Every missing food window in the ledger that motivated this
// was a FORGOTTEN LOG rather than a skipped meal, and nothing in the app noticed. The
// obvious fix — a "you missed lunch" message — is the one the attention doctrine
// forbids: the system may reduce contact unilaterally and may never increase it
// (docs/internals/findings.md §2). So the gap is stated as a CLAUSE on the food nudge
// that was already going to fire for the NEXT window, which is ride-the-nag in its
// strictest form: no `notify_*` marker, no dedupe key, no stored state, nothing on the
// suppression bus. Log something in the window and the clause disappears on its own,
// because it is a pure function of a trailing slice of the ledger.
//
// WHAT IT MAY CLAIM. The app cannot tell a forgotten log from a skipped meal and never
// will, so the notice is an observation about the LEDGER and never about the person:
// it reports that a window derived no events. `foodWindowGapLine` (lib/notifications/
// food-format.ts) holds the copy that follows from that.
//
// THE HABIT GATE. A window nobody logs is not a gap — a person who never logs breakfast
// must not be told daily that breakfast is missing. The gate is the one the issue
// specifies: the window has to have been logged on a MAJORITY of the profile's recent
// logging days.
//
// AND IT STAYS HERE, now that #2380 has landed. That measure asks a DIFFERENT question
// over the same events and says so in its own words (lib/food-regularity.ts): its
// denominator is the days a window was logged AT ALL, precisely so that "a day with no
// morning log is evidence about whether they logged breakfast, which is a different
// question and a different feature (#2376)". So the two are not one computation wearing
// two names — one asks which GROUPS recur inside a window that is being logged, this one
// asks whether the WINDOW is logged — and folding this into `foodRegularity` would
// re-absorb exactly the split that keeps its own answer honest. What they do owe each
// other is window coherence, below.

import { shiftDateStr } from "./date";
import type { FoodSlot, FoodSlotBoundaries } from "./food-slot";

// The trailing window the habit gate reads. It nests STRICTLY INSIDE both other engines
// reading this ledger — the food-group right-sizing window (RIGHTSIZE_WINDOW_DAYS, 28 —
// "you have been under this floor for a month") and the regularity span
// (FOOD_REGULARITY_SPAN_DAYS, 21 — "which groups show up nearly every time"), per the
// window-coherence convention in docs/internals/findings.md §4: engines reading one
// ledger must not be able to fire off the same evidence and say different things. Both
// pinned by lib/__tests__/food-window-gap.test.ts.
export const FOOD_WINDOW_HABIT_DAYS = 14;

// How many LOGGING DAYS the trailing window must contain before "a majority" means
// anything. Two days out of three is not a habit, and a profile that has just started
// logging (or has only ever logged once) must produce nothing at all rather than a
// notice built on a sample of one.
export const FOOD_WINDOW_HABIT_MIN_DAYS = 5;

// Which window a nudge's window follows, and on which day that predecessor sits. Food
// space is the three windows of lib/food-slot in clock order, so the predecessor is
// cyclic: Morning's is YESTERDAY's Evening, which is what gives Evening a reporting
// path at all (there is no fourth window later in the day to carry it).
export function previousFoodWindow(window: FoodSlot): {
  window: FoodSlot;
  dayOffset: 0 | -1;
} {
  switch (window) {
    case "Morning":
      return { window: "Evening", dayOffset: -1 };
    case "Midday":
      return { window: "Morning", dayOffset: 0 };
    case "Evening":
      return { window: "Midday", dayOffset: 0 };
  }
}

// The minute of day a window stops accepting events, on the profile's own boundaries.
// Evening runs to midnight (lib/food-slot says so), so it closes at the day rollover.
export function foodWindowCloseMinute(
  window: FoodSlot,
  b: FoodSlotBoundaries
): number {
  switch (window) {
    case "Morning":
      return b.midday;
    case "Midday":
      return b.evening;
    case "Evening":
      return 24 * 60;
  }
}

// The profile-local instant the decision is made at: which calendar day it is for this
// person, and how far into that day they are.
export interface LocalNow {
  date: string; // YYYY-MM-DD in the profile's timezone
  minuteOfDay: number; // 0..1439 in the profile's timezone
}

// The ledger slice the decision reads: for each calendar date, the set of windows that
// derived AT LEAST ONE food event, using the one existing precedence (`foodEventWindow`
// — explicit slot → occurred_at → tap instant).
//
// A date that is ABSENT from the map derived nothing, and that is deliberately not the
// same thing as a gap: days before the events ledger existed carry no derivable window
// at all, and a day nobody logged is indistinguishable from one. Both are simply not
// evidence, so they leave the habit gate's denominator rather than counting against it.
export type LoggedFoodWindows = ReadonlyMap<string, ReadonlySet<FoodSlot>>;

// What the nudge is told: a window, the day it belongs to, and whether that day is the
// nudge's own. `sameDay` is the only thing the copy needs beyond the window name —
// "today" vs "yesterday" — and it is decided here rather than re-derived by comparing
// date strings in a renderer.
export interface FoodWindowGap {
  window: FoodSlot;
  date: string;
  sameDay: boolean;
}

// How habitual a window is over the trailing evidence days: the number of days that
// derived any food event at all, and how many of those included this window. Exported
// because "is this window habitual" is the claim the gate rests on and is worth
// asserting directly.
export interface FoodWindowHabit {
  loggingDays: number;
  windowDays: number;
}

export function foodWindowHabit(
  logged: LoggedFoodWindows,
  dates: readonly string[],
  window: FoodSlot
): FoodWindowHabit {
  let loggingDays = 0;
  let windowDays = 0;
  for (const date of dates) {
    const windows = logged.get(date);
    if (!windows || windows.size === 0) continue;
    loggingDays++;
    if (windows.has(window)) windowDays++;
  }
  return { loggingDays, windowDays };
}

// A strict majority of the profile's recent logging days, over a sample big enough to
// mean something. Ties do NOT pass: seven of fourteen is "sometimes", and the notice is
// only meaningful against an established pattern.
export function isHabitualFoodWindow(habit: FoodWindowHabit): boolean {
  if (habit.loggingDays < FOOD_WINDOW_HABIT_MIN_DAYS) return false;
  return habit.windowDays * 2 > habit.loggingDays;
}

export interface FoodWindowGapInput {
  // The window whose nudge is being built, and the profile-local day it logs to.
  window: FoodSlot;
  date: string;
  // The profile-local now, so a window is only ever called empty once it has actually
  // CLOSED. A slot can fire before its predecessor's boundary on a partially configured
  // schedule (the boundaries then fall back to the fixed 11:00/15:00 defaults while the
  // slot times do not), and a rebuild can run long after the nudge's own day.
  now: LocalNow;
  boundaries: FoodSlotBoundaries;
  // The ledger slice: the gap day plus the FOOD_WINDOW_HABIT_DAYS days before it.
  logged: LoggedFoodWindows;
}

// The whole decision. Null — say nothing — is the answer for every case that is not an
// established window observably closing empty:
//
//   • the predecessor window has not closed yet;
//   • it derived at least one event (including a protein tap: a shake is eating, and
//     claiming "nothing logged" over one would be false about the ledger);
//   • the profile does not habitually log that window, or has not logged enough days
//     for "habitually" to mean anything — which is also how a profile that has never
//     logged food at all, and one whose history predates the events ledger, stay silent.
export function foodWindowGap(input: FoodWindowGapInput): FoodWindowGap | null {
  const { window: gapWindow, dayOffset } = previousFoodWindow(input.window);
  const gapDate = shiftDateStr(input.date, dayOffset);

  // Closed? A day earlier than the profile's own today is over; a later one has not
  // started; today is closed only past the window's own boundary.
  if (gapDate > input.now.date) return null;
  if (
    gapDate === input.now.date &&
    input.now.minuteOfDay < foodWindowCloseMinute(gapWindow, input.boundaries)
  )
    return null;

  if (input.logged.get(gapDate)?.has(gapWindow)) return null;

  // Evidence STOPS at the day before the gap: a window cannot be part of the pattern
  // it is being measured against.
  const habitDates: string[] = [];
  for (let i = FOOD_WINDOW_HABIT_DAYS; i >= 1; i--)
    habitDates.push(shiftDateStr(gapDate, -i));
  if (
    !isHabitualFoodWindow(foodWindowHabit(input.logged, habitDates, gapWindow))
  )
    return null;

  return { window: gapWindow, date: gapDate, sameDay: gapDate === input.date };
}

// The calendar dates the gather has to cover for a given nudge (oldest first): the gap
// day and the habit-evidence days before it. Exported so the query window is stated
// once, by the module that decides what it needs, rather than being re-derived by the
// gather and drifting from it.
export function foodWindowGapDates(
  window: FoodSlot,
  date: string
): { from: string; to: string } {
  const { dayOffset } = previousFoodWindow(window);
  const gapDate = shiftDateStr(date, dayOffset);
  return { from: shiftDateStr(gapDate, -FOOD_WINDOW_HABIT_DAYS), to: gapDate };
}
