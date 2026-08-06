// Weekly-rhythm inference (#2188): the ONE pure computation behind "which weekdays
// does this person habitually do X, and at what hour?" — extracted from the workout
// schedule inference (#558) so the practice inference is the SAME shape rather than
// a drifting copy. `inferWorkoutSchedule` (lib/queries/training/activities.ts) and
// `inferPracticeSchedule` (lib/queries/wellness.ts) are both thin SQL gathers over
// this core.
//
// THE SHARED THRESHOLDS LIVE HERE AND ONLY HERE (#2188 constraint 1):
//
//   • the window: `RHYTHM_WINDOW_WEEKS` (8 weeks of history);
//   • the habitual-weekday gate: `rhythmMinDates` — a weekday counts only when it
//     was logged on ≥ max(2, ceil(weeks × 0.4)) DISTINCT dates in the window;
//   • the evening fallback hour: `RHYTHM_EVENING_FALLBACK_HOUR` (18:00) when no
//     logged time gives a better answer.
//
// The ONE deliberate practice divergence is also here, in `inferPracticeRhythm`:
// the practice fallback-hour ladder consults the practice's OWN full history
// before settling on the shared evening default (see its comment). Nothing else
// diverges — a threshold change edits this file or it isn't a decision.
//
// THE HONESTY RULE (#558): `hasPattern: false` means the weekdays are the
// "every day" fallback, and every consumer that asks "is TODAY specifically a
// predicted day?" must treat that as UNKNOWN — render nothing, retime nothing —
// never as "yes, every day". `predictedOnDay` encodes that as the tri-state the
// workout pair already uses.

import { shiftDateStr, weekdayOfDateStr } from "./date";

// One dated log row as the inference consumes it: the day it happened and the
// optional local "HH:MM" start time.
export interface RhythmRow {
  date: string;
  time: string | null;
}

export interface WeeklyRhythm {
  weekdays: number[]; // 0=Sun … 6=Sat habitually logged
  hour: number; // typical local start hour
  // False means `weekdays` is the "every day" fallback — see the header. Consumers
  // that need "is today specifically predicted?" go through predictedOnDay.
  hasPattern: boolean;
}

export const RHYTHM_WINDOW_WEEKS = 8;

export const RHYTHM_EVENING_FALLBACK_HOUR = 18;

// A weekday is habitual when logged on at least this many DISTINCT dates within
// the window: 40% of the window's weeks, floored at 2 so a tiny window can never
// promote a single occurrence into a "pattern".
export function rhythmMinDates(weeks: number): number {
  return Math.max(2, Math.ceil(weeks * 0.4));
}

// The most common valid start hour among `times`, or null when none parses. Ties
// keep the FIRST hour to reach the top count in input order — the same first-max
// discipline the workout inference has always had, so extracting it changed no
// answer. Callers that need determinism order their rows before calling.
export function modalHour(times: readonly (string | null)[]): number | null {
  const counts = new Map<number, number>();
  for (const t of times) {
    if (!t) continue;
    const h = Number(t.slice(0, 2));
    if (Number.isInteger(h) && h >= 0 && h <= 23)
      counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  let hour: number | null = null;
  let best = 0;
  for (const [h, c] of counts) if (c > best) ((best = c), (hour = h));
  return hour;
}

// The core: the workout inference's exact shape (#558) over caller-supplied rows.
// Habitual weekdays by distinct-date count, modal start hour with `fallbackHour`
// when no row carries a time, honest `hasPattern: false` (weekdays = every day)
// when no weekday clears the gate.
export function inferWeeklyRhythm(
  rows: readonly RhythmRow[],
  opts: { weeks?: number; fallbackHour?: number } = {}
): WeeklyRhythm {
  const weeks = opts.weeks ?? RHYTHM_WINDOW_WEEKS;
  const datesByWeekday = new Map<number, Set<string>>();
  for (const r of rows) {
    const wd = weekdayOfDateStr(r.date);
    let set = datesByWeekday.get(wd);
    if (!set) datesByWeekday.set(wd, (set = new Set()));
    set.add(r.date);
  }

  const hour =
    modalHour(rows.map((r) => r.time)) ??
    opts.fallbackHour ??
    RHYTHM_EVENING_FALLBACK_HOUR;

  const minDates = rhythmMinDates(weeks);
  const weekdays = [...datesByWeekday.entries()]
    .filter(([, dates]) => dates.size >= minDates)
    .map(([wd]) => wd)
    .sort((a, b) => a - b);

  if (weekdays.length === 0)
    return { weekdays: [0, 1, 2, 3, 4, 5, 6], hour, hasPattern: false };
  return { weekdays, hour, hasPattern: true };
}

// The practice adapter (#2188): the shared core over a practice's FULL log history,
// windowed to the trailing `weeks` before `asOf` for the weekday gate.
//
// THE ONE DELIBERATE DIVERGENCE from the workout module — the fallback-hour
// ladder. A workout row nearly always carries a start time, so the workout
// inference goes modal-hour-else-evening. A practice session is usually a bare
// one-tap log with NO time, so when the window has no times the practice's own
// most common logged hour ANYWHERE in its history (its habitual part of day) is a
// better answer than a generic evening — and only when the practice has never
// carried a time at all does it settle on the shared evening default. Recency
// still wins: any time inside the window feeds the modal directly.
export function inferPracticeRhythm(
  rows: readonly RhythmRow[],
  asOf: string,
  weeks = RHYTHM_WINDOW_WEEKS
): WeeklyRhythm {
  const start = shiftDateStr(asOf, -weeks * 7);
  const windowRows = rows.filter((r) => r.date >= start);
  const fallbackHour =
    modalHour(rows.map((r) => r.time)) ?? RHYTHM_EVENING_FALLBACK_HOUR;
  return inferWeeklyRhythm(windowRows, { weeks, fallbackHour });
}

// Tri-state "is `date` a predicted day?" (#558's isPredictedWorkoutDay shape):
// null when no rhythm exists, so a consumer can never mistake the every-day
// fallback for "yes". Every rendered surface and the nudge retimer key on this.
export function predictedOnDay(
  rhythm: WeeklyRhythm,
  date: string
): boolean | null {
  if (!rhythm.hasPattern) return null;
  return rhythm.weekdays.includes(weekdayOfDateStr(date));
}
