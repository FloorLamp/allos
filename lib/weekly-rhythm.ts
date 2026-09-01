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

// The most common value, with ties kept by input order. Readers put newest rows
// first when "most recent wins" is their tie-break.
export function modalValue<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let answer: T | null = null;
  let best = 0;
  for (const [value, count] of counts)
    if (count > best) ((best = count), (answer = value));
  return answer;
}

// The most common valid start hour among `times`, or null when none parses.
export function modalHour(times: readonly (string | null)[]): number | null {
  return modalValue(
    times.flatMap((time) => {
      if (!time) return [];
      const hour = Number(time.slice(0, 2));
      return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? [hour] : [];
    })
  );
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

// The practice adapter (#2188): the shared core over a practice's log history up to
// `asOf`, windowed to the trailing `weeks` before it for the weekday gate.
//
// AS OF `asOf` AT BOTH ENDS (#4030). `asOf` set the window's START only, so a session
// logged for NEXT Monday counted toward this Monday's habit and the answer to "what
// was inferable as of D" included days that had not happened: as of 2026-05-12 with
// two Mondays elapsed and two logged ahead, this returned a Monday pattern off four.
// The workout sibling bounds its gather the same way (#4026), so the two siblings
// answer the one question with the one computation.
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
  // The hour ladder reads the practice's own history rather than the window (see
  // above) — but history, not the future: a time logged ahead is no more evidence of
  // a habitual hour than a session logged ahead is of a habitual day.
  const history = rows.filter((r) => r.date <= asOf);
  const windowRows = history.filter((r) => r.date >= start);
  const fallbackHour =
    modalHour(history.map((r) => r.time)) ?? RHYTHM_EVENING_FALLBACK_HOUR;
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

// ---- The rhythm MOMENT a dashboard window opens in (#3224) ------------------
//
// "Is now a moment this normally happens?" — the dashboard's question, answered
// from the same predicted-day/typical-hour signal the nudge retimer reads
// (`practiceNudgeReleased`, lib/practice.ts). Distinct from that one on purpose:
// the nudge asks "may I send yet", so it releases from the typical hour onward
// and falls back to sending anyway once the week's last predicted day has passed
// — a message must never be silently lost. A Now card is not a send. It asks
// whether THIS minute is the moment, so it is a band centred on the typical hour
// and it closes again afterwards; nothing is lost when it does, because the
// action stays in Show everything's Act group and a behind-pace target still
// carries `owed`.
//
// The honesty rule (see this file's header) is the first line: no pattern means
// UNKNOWN, and an unknown moment is not an open one.
export const RHYTHM_MOMENT_MIN = 90;

export function rhythmMomentOpen(
  rhythm: WeeklyRhythm,
  date: string,
  minuteOfDay: number
): boolean {
  if (predictedOnDay(rhythm, date) !== true) return false;
  // Circular distance from the typical hour, so a band around 00:00 or 23:00
  // reaches across midnight into the same day's minutes rather than truncating.
  const offset = (minuteOfDay - rhythm.hour * 60 + 1440) % 1440;
  return offset <= RHYTHM_MOMENT_MIN || offset >= 1440 - RHYTHM_MOMENT_MIN;
}
