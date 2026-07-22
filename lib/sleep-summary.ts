// Pure formatters for the dedicated Sleep page (issue #1066) and its dashboard
// "last night" tile. NO new engine — every value here is derived from the SAME
// sleep sessions the SRI/pillar computations already read, run through the
// shared main-vs-nap classifier (#1118). The page hero and the dashboard tile
// both consume `lastNightSummary`, so the two surfaces can't disagree about
// "how did I sleep last night" (the one-question-one-computation rule, #221).
//
// Pure — no DB, no clock, no network — so the same math runs in the page, the
// widget, and the unit tests. Timezone-correct: all clock math converts each
// stored absolute instant to profile-local wall clock via zonedDateParts.

import { shiftDateStr, zonedDateParts } from "./date";
import { mainSleepSession, type SleepSession } from "./sleep-regularity";

// A night's stage breakdown (minutes), as stored per wake-day in metric_samples
// (getSleepStageDailyTotals). These are the DAY totals (they sum a same-day nap's
// stages if any) — the hero renders them as an at-a-glance composition, not a
// per-session split, which the stored samples don't carry.
export interface SleepStageMinutes {
  deep: number;
  rem: number;
  light: number;
  awake: number;
}

// The "last night" model: the MAIN overnight session (#1118) reduced to the facts
// the hero and the dashboard tile render — never a score (the pillars-not-a-
// composite stance). A same-day nap is a SEPARATE figure (`napMin`), never folded
// into `durationMin`.
export interface LastNightSummary {
  // Local calendar date of the main session's END (the wake-up day).
  wakeDay: string;
  // Main overnight session duration, minutes.
  durationMin: number;
  // Local minute-of-day (0..1439) of sleep onset and wake for the main session.
  // A NUMBER, not a baked clock string, so the render layer formats it through the
  // login's 12h/24h pref (formatClockMinutes) — issue #1163.
  bedMinutes: number;
  wakeMinutes: number;
  // Sum of any OTHER (nap) sessions that wake-day, minutes; 0 when there were none.
  napMin: number;
  // Trailing-baseline mean of MAIN-session durations over the prior `baselineDays`
  // nights (this night excluded), or null when there aren't enough prior nights.
  baselineAvgMin: number | null;
  // durationMin − baselineAvgMin (signed minutes), or null when no baseline.
  deltaMin: number | null;
  // Number of prior nights the baseline averaged over.
  baselineNights: number;
  // This wake-day's stage composition, or null when stages weren't recorded.
  stages: SleepStageMinutes | null;
}

function sessionMinutes(s: SleepSession): number {
  return Math.round(
    (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000
  );
}

// Group valid sessions by profile-local wake-day (calendar date of the END), the
// same anchor mainSleepNights / buildNights use.
function groupByWakeDay(
  sessions: SleepSession[],
  tz: string
): Map<string, SleepSession[]> {
  const byDay = new Map<string, SleepSession[]>();
  for (const s of sessions) {
    const a = new Date(s.start).getTime();
    const b = new Date(s.end).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    const day = zonedDateParts(tz, new Date(s.end)).date;
    const arr = byDay.get(day);
    if (arr) arr.push(s);
    else byDay.set(day, [s]);
  }
  return byDay;
}

// The most-recent night's summary, or null when the profile has no usable sleep
// session. The hero AND the dashboard tile read THIS — same inputs, same answer.
export function lastNightSummary(
  sessions: SleepSession[],
  tz: string,
  stagesByDay: Map<string, SleepStageMinutes> = new Map(),
  opts: { baselineDays?: number } = {}
): LastNightSummary | null {
  const baselineDays = opts.baselineDays ?? 30;
  const byDay = groupByWakeDay(sessions, tz);
  if (byDay.size === 0) return null;

  const days = [...byDay.keys()].sort();
  const latest = days[days.length - 1];
  const group = byDay.get(latest)!;
  const main = mainSleepSession(group);
  if (!main) return null; // every session that day was a labeled nap

  const durationMin = sessionMinutes(main);
  const napMin = group
    .filter((s) => s !== main)
    .reduce((t, s) => t + sessionMinutes(s), 0);

  // Baseline: the mean MAIN-session duration over the prior wake-days that fall in
  // [latest − baselineDays, latest − 1]. Uses the SAME main-vs-nap classification
  // per day so the average reflects overnight sleep, not nap-inflated totals.
  const lower = shiftDateStr(latest, -baselineDays);
  const priorMains: number[] = [];
  for (const d of days) {
    if (d >= latest || d < lower) continue;
    const m = mainSleepSession(byDay.get(d)!);
    if (m) priorMains.push(sessionMinutes(m));
  }
  const baselineNights = priorMains.length;
  const baselineAvgMin =
    baselineNights > 0
      ? Math.round(priorMains.reduce((a, b) => a + b, 0) / baselineNights)
      : null;
  const deltaMin = baselineAvgMin == null ? null : durationMin - baselineAvgMin;

  return {
    wakeDay: latest,
    durationMin,
    bedMinutes: hhmmToMinutes(zonedDateParts(tz, new Date(main.start)).hhmm),
    wakeMinutes: hhmmToMinutes(zonedDateParts(tz, new Date(main.end)).hhmm),
    napMin,
    baselineAvgMin,
    deltaMin,
    baselineNights,
    stages: stagesByDay.get(latest) ?? null,
  };
}

// Phrase the baseline delta for the hero, e.g. "40m under your average" /
// "18m over your average" / "right on your average". Returns null when there is
// no baseline yet (fewer than one prior night). Pure so the page and any future
// surface phrase it identically.
export function baselineDeltaPhrase(summary: LastNightSummary): string | null {
  if (summary.deltaMin == null) return null;
  const abs = Math.abs(summary.deltaMin);
  if (abs < 5) return "right on your average";
  const mag = abs >= 60 ? formatHm(abs) : `${abs}m`;
  return summary.deltaMin < 0
    ? `${mag} under your average`
    : `${mag} over your average`;
}

// "7h 12m" for a whole-minute count (hero + tile headline). Separate from
// lib/duration.formatMinutes ("45 min" / "1h 05m") so the sleep headline reads as
// a single compact figure with no zero-padding.
export function formatHm(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// A recorded night reduced to its main-session bed/wake clock hours (decimal,
// noon-anchored so a normal evening→morning night stays contiguous across
// midnight) — the input to the consistency strip. `weekend` flags Sat/Sun wake.
export interface ConsistencyNight {
  date: string; // wake-day (YYYY-MM-DD)
  bedHour: number; // noon-relative decimal hour of onset (12.0 = noon .. 36.0)
  wakeHour: number; // noon-relative decimal hour of wake
  weekend: boolean;
}

// Minute-of-day (0..1439) of a local "HH:MM". The model emits this NUMBER so the
// render layer formats the clock through the login's 12h/24h pref (#1163).
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Noon-anchored decimal clock hour of a local "HH:MM": 12:00→12.0, 23:30→23.5,
// 00:00→24.0, 07:00→31.0. Anchoring at noon keeps a normal night contiguous (no
// midnight wrap) so bedtime and wake plot on one monotone axis.
function noonHour(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const raw = h + m / 60;
  return raw < 12 ? raw + 24 : raw;
}

// The main overnight bed/wake per night for the consistency strip. Takes the
// classifier's per-night sessions (mainSleepNights output) so nap sessions are
// already dropped, and re-expresses each in noon-anchored clock hours in `tz`.
export function consistencyNights(
  mainNights: { wakeDay: string; start: string; end: string }[],
  tz: string
): ConsistencyNight[] {
  return mainNights.map((n) => {
    const bed = zonedDateParts(tz, new Date(n.start)).hhmm;
    const wake = zonedDateParts(tz, new Date(n.end)).hhmm;
    const dow = new Date(`${n.wakeDay}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    return {
      date: n.wakeDay,
      bedHour: noonHour(bed),
      wakeHour: noonHour(wake),
      weekend: dow === 0 || dow === 6,
    };
  });
}

// A dated {sleep, mood} pair for the sleep↔mood section — only nights that have
// BOTH a main-session duration and a mood check-in that day. Pure join.
export interface SleepMoodPoint {
  date: string;
  sleepHours: number; // main-session hours, one decimal
  valence: number; // mood 1..5
}

export function pairSleepMood(
  nights: { date: string; value: number }[],
  moods: { date: string; valence: number }[]
): SleepMoodPoint[] {
  const moodByDate = new Map(moods.map((m) => [m.date, m.valence]));
  const out: SleepMoodPoint[] = [];
  for (const n of nights) {
    const valence = moodByDate.get(n.date);
    if (valence == null) continue;
    out.push({
      date: n.date,
      sleepHours: Math.round((n.value / 60) * 10) / 10,
      valence,
    });
  }
  return out;
}
