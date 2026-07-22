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

import { daysBetweenDateStr, shiftDateStr, zonedDateParts } from "./date";
import {
  formatLongDate,
  formatRelativeDate,
  type DisplayFormatPrefs,
} from "./format-date";
import { mainSleepSession, type SleepSession } from "./sleep-regularity";
import type { BedtimeSupplementSummary } from "./sleep-bedtime-supplements";

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
  bedMinutes: number | null;
  wakeMinutes: number | null;
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
  // Source of the chosen main session when known. Null means a manual or legacy
  // row whose provenance was not recorded.
  source: string | null;
}

function sessionMinutes(s: SleepSession): number {
  const reported = Number(s.value);
  if (Number.isFinite(reported) && reported > 0) return Math.round(reported);
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
    // Daily stage totals can include a same-wake-day nap. Do not attach those to
    // a hero explicitly describing the MAIN overnight session; the full stage
    // chart below remains an honest wake-day total.
    stages: napMin > 0 ? null : (stagesByDay.get(latest) ?? null),
    source: main.source ?? null,
  };
}

// Duration-only fallback for manual sleep rows. Manual quick-add deliberately
// stores a daily amount without inventing bedtime/wake clocks; this keeps that
// honest while still letting the Sleep page show a useful latest value + baseline.
export function latestDailySleepSummary(
  totals: { date: string; value: number }[],
  source: string | null = null,
  opts: { baselineDays?: number } = {}
): LastNightSummary | null {
  if (totals.length === 0) return null;
  const valid = totals
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.value > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (valid.length === 0) return null;
  const latest = valid[valid.length - 1];
  const lower = shiftDateStr(latest.date, -(opts.baselineDays ?? 30));
  const prior = valid.filter((r) => r.date >= lower && r.date < latest.date);
  const baselineAvgMin =
    prior.length === 0
      ? null
      : Math.round(prior.reduce((sum, r) => sum + r.value, 0) / prior.length);
  const durationMin = Math.round(latest.value);
  return {
    wakeDay: latest.date,
    durationMin,
    bedMinutes: null,
    wakeMinutes: null,
    napMin: 0,
    baselineAvgMin,
    deltaMin: baselineAvgMin == null ? null : durationMin - baselineAvgMin,
    baselineNights: prior.length,
    stages: null,
    source,
  };
}

export type SleepRecordFreshness = "last-night" | "recent" | "stale";

export interface SleepRecordPresentation {
  freshness: SleepRecordFreshness;
  label: string;
}

// Issue #1186: "Last night" is a strict relative-day claim, not a synonym for
// "latest row". This ONE pure formatter is shared by the page hero + dashboard
// tile. Recent lag stays visible with an honest dated label; older lag is hidden
// behind a sync-oriented empty state. Four nights is the pinned relabel window.
export function sleepRecordPresentation(
  wakeDay: string,
  todayStr: string,
  prefs: DisplayFormatPrefs,
  recentWindowNights = 4
): SleepRecordPresentation {
  const nightsAgo = daysBetweenDateStr(wakeDay, todayStr);
  if (nightsAgo === 1) {
    return { freshness: "last-night", label: "Last night" };
  }
  if (nightsAgo != null && nightsAgo >= 0 && nightsAgo <= recentWindowNights) {
    const relative = formatRelativeDate(wakeDay, todayStr).replace(
      /\bday(s?) ago\b/,
      "night$1 ago"
    );
    return {
      freshness: "recent",
      label: `${formatLongDate(wakeDay, prefs)} · ${relative}`,
    };
  }
  return { freshness: "stale", label: "Sleep not synced" };
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

// Calendar-window filter for the Sleep page's range selector. A range means the
// last N profile-local dates ending at `endDate`, not the last N observations;
// future-dated rows are excluded. Shared by availability and chart rendering so
// a button can never claim data that its selected chart then drops.
export function sleepTrendWindow<T extends { date: string }>(
  rows: T[],
  endDate: string,
  days: number
): T[] {
  const boundedDays = Math.max(1, Math.floor(days));
  const startDate = shiftDateStr(endDate, -(boundedDays - 1));
  return rows.filter((row) => row.date >= startDate && row.date <= endDate);
}

// Build the nested calendar windows for the Sleep range selector and mark a
// range available only when it reveals observations the preceding, shorter
// range does not. Merely containing the same recent points is not useful: a
// disabled "90 days" button truthfully says there is nothing more to show.
export function sleepTrendRangeWindows<
  TDuration extends { date: string },
  TStages extends { date: string },
>(
  durationRows: TDuration[],
  stageRows: TStages[],
  endDate: string,
  ranges: readonly number[]
): {
  days: number;
  duration: TDuration[];
  stages: TStages[];
  hasAdditionalData: boolean;
}[] {
  let previousObservationCount = 0;
  return ranges.map((days) => {
    const duration = sleepTrendWindow(durationRows, endDate, days);
    const stages = sleepTrendWindow(stageRows, endDate, days);
    const observationCount = duration.length + stages.length;
    const hasAdditionalData = observationCount > previousObservationCount;
    previousObservationCount = observationCount;
    return { days, duration, stages, hasAdditionalData };
  });
}

// A recorded night reduced to its main-session bed/wake clock hours (decimal,
// noon-anchored so a normal evening→morning night stays contiguous across
// midnight) — the input to the consistency strip. `weekend` flags Sat/Sun wake.
export interface ConsistencyNight {
  date: string; // wake-day (YYYY-MM-DD)
  bedHour: number; // noon-relative decimal hour of onset (12.0 = noon .. 36.0)
  wakeHour: number; // noon-relative decimal hour of wake
  weekend: boolean;
  // Difference from the canonical typical schedule. Null until there are enough
  // nights for a meaningful baseline; "off schedule" means either boundary is
  // more than the configured threshold away.
  bedDeviationMin: number | null;
  wakeDeviationMin: number | null;
  offSchedule: boolean;
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
  tz: string,
  schedule: {
    typicalBedMinute?: number | null;
    typicalWakeMinute?: number | null;
  } = {}
): ConsistencyNight[] {
  const rows = mainNights.map((n) => {
    const bed = zonedDateParts(tz, new Date(n.start)).hhmm;
    const wake = zonedDateParts(tz, new Date(n.end)).hhmm;
    const dow = new Date(`${n.wakeDay}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    return {
      date: n.wakeDay,
      bedHour: noonHour(bed),
      wakeHour: noonHour(wake),
      weekend: dow === 0 || dow === 6,
      bedDeviationMin: null,
      wakeDeviationMin: null,
      offSchedule: false,
    };
  });
  return markOffSchedule(rows, schedule);
}

function noonRelativeMinute(clockMinute: number): number {
  return clockMinute < 12 * 60 ? clockMinute + 24 * 60 : clockMinute;
}

// Compare each night with the canonical typical schedule from sleep-regularity.
// A bedtime OR wake time more than 60 minutes away is visibly "off schedule."
// Signed deviations let the UI explain early vs late without inventing a target
// or universal bedtime.
export function markOffSchedule(
  nights: ConsistencyNight[],
  opts: {
    typicalBedMinute?: number | null;
    typicalWakeMinute?: number | null;
    thresholdMin?: number;
  } = {}
): ConsistencyNight[] {
  const thresholdMin = opts.thresholdMin ?? 60;
  const typicalBedNoonMinute =
    opts.typicalBedMinute == null
      ? null
      : noonRelativeMinute(opts.typicalBedMinute);
  const typicalWakeNoonMinute =
    opts.typicalWakeMinute == null
      ? null
      : noonRelativeMinute(opts.typicalWakeMinute);
  if (typicalBedNoonMinute == null && typicalWakeNoonMinute == null)
    return nights;
  return nights.map((night) => {
    const bedDeviationMin =
      typicalBedNoonMinute == null
        ? null
        : Math.round(night.bedHour * 60 - typicalBedNoonMinute);
    const wakeDeviationMin =
      typicalWakeNoonMinute == null
        ? null
        : Math.round(night.wakeHour * 60 - typicalWakeNoonMinute);
    return {
      ...night,
      bedDeviationMin,
      wakeDeviationMin,
      offSchedule:
        (bedDeviationMin != null && Math.abs(bedDeviationMin) > thresholdMin) ||
        (wakeDeviationMin != null && Math.abs(wakeDeviationMin) > thresholdMin),
    };
  });
}

// A dated {sleep, mood} pair for the sleep↔mood section — only nights that have
// BOTH a main-session duration and a mood check-in that day. Pure join.
export interface SleepMoodPoint {
  date: string;
  sleepHours: number; // main-session minutes expressed as hours
  valence: number; // mood 1..5
}

export interface SleepMoodHistoryRow {
  date: string;
  sleepHours: number | null;
  valence: number | null;
  moodDetails: {
    energy: number | null;
    anxiety: number | null;
    factors: string[];
    notes: string | null;
  } | null;
  stages: SleepStageMinutes | null;
  bedtimeSupplements: BedtimeSupplementSummary | null;
  // Only duration-only manual samples use the stable midnight natural key the
  // vitals writer can safely update. Imported/windowed sleep stays read-only.
  sleepEditable: boolean;
  sleepEditHours: number | null;
}

// Date union for the factual history table. Unlike pairSleepMood, this retains a
// day when only sleep, stages, or mood was logged so the table represents ALL
// available data in its window rather than silently discarding incomplete rows.
export function buildSleepMoodHistory(
  nights: { date: string; value: number }[],
  moods: {
    date: string;
    valence: number;
    energy?: number | null;
    anxiety?: number | null;
    factors?: string[];
    notes?: string | null;
  }[],
  stageRows: ({ date: string } & SleepStageMinutes)[] = []
): SleepMoodHistoryRow[] {
  const byDate = new Map<string, SleepMoodHistoryRow>();
  for (const night of nights) {
    byDate.set(night.date, {
      date: night.date,
      sleepHours: night.value / 60,
      valence: null,
      moodDetails: null,
      stages: null,
      bedtimeSupplements: null,
      sleepEditable: false,
      sleepEditHours: null,
    });
  }
  for (const mood of moods) {
    const row = byDate.get(mood.date);
    byDate.set(mood.date, {
      date: mood.date,
      sleepHours: row?.sleepHours ?? null,
      valence: mood.valence,
      moodDetails: {
        energy: mood.energy ?? null,
        anxiety: mood.anxiety ?? null,
        factors: mood.factors ?? [],
        notes: mood.notes ?? null,
      },
      stages: row?.stages ?? null,
      bedtimeSupplements: row?.bedtimeSupplements ?? null,
      sleepEditable: row?.sleepEditable ?? false,
      sleepEditHours: row?.sleepEditHours ?? null,
    });
  }
  for (const stageRow of stageRows) {
    const row = byDate.get(stageRow.date);
    byDate.set(stageRow.date, {
      date: stageRow.date,
      sleepHours: row?.sleepHours ?? null,
      valence: row?.valence ?? null,
      moodDetails: row?.moodDetails ?? null,
      stages: {
        deep: stageRow.deep,
        rem: stageRow.rem,
        light: stageRow.light,
        awake: stageRow.awake,
      },
      bedtimeSupplements: row?.bedtimeSupplements ?? null,
      sleepEditable: row?.sleepEditable ?? false,
      sleepEditHours: row?.sleepEditHours ?? null,
    });
  }
  return [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

// Mark the subset of sleep history that can be safely updated through the
// existing duration-only manual writer. A missing duration can receive a new
// manual entry. An existing duration is editable only when it has the writer's
// exact duration-only row AND no competing imported/windowed source that could
// make the displayed value disagree with the value being edited.
export function attachEditableManualSleep(
  history: SleepMoodHistoryRow[],
  manualRows: { date: string; value: number }[],
  sourceRows: { date: string; source: string }[]
): SleepMoodHistoryRow[] {
  const manualByDate = new Map(manualRows.map((row) => [row.date, row.value]));
  const sourcesByDate = new Map<string, Set<string>>();
  for (const row of sourceRows) {
    const sources = sourcesByDate.get(row.date) ?? new Set<string>();
    sources.add(row.source);
    sourcesByDate.set(row.date, sources);
  }
  return history.map((row) => {
    const manualMinutes = manualByDate.get(row.date);
    const sources = sourcesByDate.get(row.date);
    const existingIsEditable =
      manualMinutes != null && sources?.size === 1 && sources.has("manual");
    return {
      ...row,
      sleepEditable: row.sleepHours == null || existingIsEditable,
      sleepEditHours:
        existingIsEditable && manualMinutes != null ? manualMinutes / 60 : null,
    };
  });
}

export function sleepMoodPoints(
  history: SleepMoodHistoryRow[]
): SleepMoodPoint[] {
  return history.flatMap((row) =>
    row.sleepHours != null && row.valence != null
      ? [
          {
            date: row.date,
            sleepHours: row.sleepHours,
            valence: row.valence,
          },
        ]
      : []
  );
}

export function pairSleepMood(
  nights: { date: string; value: number }[],
  moods: { date: string; valence: number }[]
): SleepMoodPoint[] {
  return sleepMoodPoints(buildSleepMoodHistory(nights, moods));
}
