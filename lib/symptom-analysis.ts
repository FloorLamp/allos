// Symptom analysis (#1852): the aggregation half of "how many migraine days last
// month, and is it getting worse?".
//
// ONE computation, in lib/, over ONE reader. `getSymptomDaysInRange` is the symptom
// log's range reader and this module is its second consumer — a parallel reader for the
// same question is exactly what the reuse rule forbids. The chronological record is NOT
// here: `/history` owns the ledger (#3958). This is analysis — counts and a severity
// series — and nothing in it is ordered for reading day by day.
//
// PROFILE-LOCAL DAYS, NOT INSTANTS. `symptom_logs.date` is already the profile-local day
// the tap happened on, so the buckets below are pure string arithmetic. The timezone
// enters exactly once, upstream: the caller's `today(profileId)` anchors the window, so
// a profile east of the date line and one west of it sitting on the same instant get
// different windows and different current months. That is correct, and
// lib/__db_tests__/symptom-analysis.test.ts pins it with two profiles on one frozen
// instant rather than trusting the host zone.

import { monthStartOf, shiftMonthStart } from "./recap-scale";
import { daysBetweenDateStr, MONTHS_SHORT } from "./date";
import { getSymptomDaysInRange } from "./queries/symptoms";
import { symptomLabel } from "./symptoms";

// The analysis window: the current month plus the eleven before it. A year is the span
// the question needs — "is it getting worse" is a comparison ACROSS seasons for a
// chronic symptom — and it is the same trailing-12-months convention the week-grain
// histories already use.
export const SYMPTOM_ANALYSIS_MONTHS = 12;

// What makes a symptom RECURRING — the vocabulary is open, so a tile has to be earned
// rather than declared. Two thresholds, because one cannot separate the two cases:
// a day count alone promotes a single week of flu (fever on five consecutive days) to
// "recurring", which is the opposite of what the word means here. Spread across months
// is what distinguishes a pattern from an episode.
export const RECURRING_MIN_DAYS = 3;
export const RECURRING_MIN_MONTHS = 2;

export interface SymptomMonthDays {
  /** The month's first day, YYYY-MM-DD. */
  month: string;
  /** "Aug" — the axis label. */
  label: string;
  /** Distinct days this symptom was logged in that month. */
  days: number;
}

export interface SymptomSeverityPoint {
  date: string;
  /** The day's stored severity, 1–4. One row per symptom-day, so this is the day's worst. */
  severity: number;
}

export interface SymptomAnalysisEntry {
  /** The stored key — a curated slug or a custom name. */
  symptom: string;
  label: string;
  /** Distinct days logged across the whole window. */
  days: number;
  /** Every month of the window, oldest first, zeros included so the axis is a real axis. */
  months: SymptomMonthDays[];
  /** One point per symptom-day, oldest first — the severity strip. */
  severity: SymptomSeverityPoint[];
  recurring: boolean;
}

export interface SymptomAnalysis {
  /** The window's first day (a month start) and last day (the profile's today). */
  from: string;
  to: string;
  /** The window's months, oldest first, as first-of-month dates. */
  months: string[];
  /** Every symptom logged in the window, most days first then alphabetical. */
  entries: SymptomAnalysisEntry[];
  /** The subset that earns a tile. Same objects, same order. */
  recurring: SymptomAnalysisEntry[];
}

/** The trailing-`SYMPTOM_ANALYSIS_MONTHS` window ending on a profile-local day. */
export function symptomAnalysisWindow(todayStr: string): {
  from: string;
  to: string;
  months: string[];
} {
  const currentMonth = monthStartOf(todayStr);
  const months: string[] = [];
  for (let i = SYMPTOM_ANALYSIS_MONTHS - 1; i >= 0; i--)
    months.push(shiftMonthStart(currentMonth, -i));
  return { from: months[0], to: todayStr, months };
}

function monthLabel(monthStart: string): string {
  return MONTHS_SHORT[Number(monthStart.slice(5, 7)) - 1];
}

/**
 * The whole analysis for a profile, over the trailing-year window ending on
 * `todayStr` (the caller's profile-local today — see the header).
 */
export function buildSymptomAnalysis(
  profileId: number,
  todayStr: string
): SymptomAnalysis {
  const { from, to, months } = symptomAnalysisWindow(todayStr);
  // THE LIMIT IS THE WINDOW, NOT THE READER'S DEFAULT. `getSymptomDaysInRange` caps at
  // 250 DAYS in JS after the read, so a profile that logs something most days would
  // silently lose the oldest ~115 days of a 12-month window — and the lost end is
  // exactly the half "is it getting worse" compares against. Ask for every day the
  // window can hold.
  const dayCount = (daysBetweenDateStr(from, to) ?? 0) + 1;
  const days = getSymptomDaysInRange(profileId, from, to, dayCount);

  const byKey = new Map<
    string,
    {
      days: Set<string>;
      months: Map<string, number>;
      severity: SymptomSeverityPoint[];
    }
  >();
  for (const day of days) {
    const month = monthStartOf(day.date);
    for (const entry of day.symptoms) {
      let acc = byKey.get(entry.symptom);
      if (!acc) {
        acc = { days: new Set(), months: new Map(), severity: [] };
        byKey.set(entry.symptom, acc);
      }
      if (acc.days.has(day.date)) continue;
      acc.days.add(day.date);
      acc.months.set(month, (acc.months.get(month) ?? 0) + 1);
      acc.severity.push({ date: day.date, severity: entry.severity });
    }
  }

  const entries: SymptomAnalysisEntry[] = [...byKey.entries()]
    .map(([symptom, acc]) => ({
      symptom,
      label: symptomLabel(symptom),
      days: acc.days.size,
      months: months.map((month) => ({
        month,
        label: monthLabel(month),
        days: acc.months.get(month) ?? 0,
      })),
      severity: acc.severity.sort((a, b) => a.date.localeCompare(b.date)),
      recurring:
        acc.days.size >= RECURRING_MIN_DAYS &&
        acc.months.size >= RECURRING_MIN_MONTHS,
    }))
    .sort(
      (a, b) => b.days - a.days || a.label.localeCompare(b.label, undefined)
    );

  return {
    from,
    to,
    months,
    entries,
    recurring: entries.filter((e) => e.recurring),
  };
}
