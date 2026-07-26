// Trends → Fitness, the WINDOWED ANALYTICS LENS (issue #1492) — pure layer.
//
// The rule the tab now obeys: **analyze on Trends, do on /training**. Fitness used
// to re-mount /training's Strength/Cardio/Sport sections verbatim behind a nested
// `?ftab=` strip — full history, un-windowed, on a page whose subtitle promises
// "under one date range". It is now four SECTIONS (volume & cadence, zones &
// cardio, strength progression, sport), every one of them reading the hub's shared
// window.
//
// This module owns the pure decisions that windowing needs, so they're unit-tested
// rather than inlined on a Server Component:
//   • the window itself (`fitnessWindow`) — the hub's DateRange resolved to a
//     concrete [from, to] plus its length in days (null = all time),
//   • how many WEEK columns a window is worth (`fitnessWindowWeeks`) — the heatmap
//     and the weekly zone/cardio charts all scope by week count,
//   • which PRs are "this window" and which three lead (`selectWindowPRs`).
//
// It deliberately contains NO record detection: the PR engines stay `recentPRs` /
// `recentCardioPRs` in lib/coaching (#221 — a windowed surface reuses the existing
// computation with a window parameter, it never forks a second engine). The
// callers hand this module the ALREADY-detected records and it only merges/ranks.

import type { CardioPR, PR } from "./coaching";
import { daysBetweenDateStr, shiftDateStr } from "./date";
import type { DateRange } from "./timeline-format";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

// The four sections, in render order. PINNED composition (owner-decided,
// 2026-07-25): exactly these, no others. The ids double as the in-page `#anchor`
// the jump chips scroll to — the #1486/#1067 section pattern that replaced the
// nested tab strip.
export const FITNESS_SECTIONS = [
  { id: "volume", label: "Volume & cadence" },
  { id: "zones", label: "Zones & cardio" },
  { id: "strength", label: "Strength progression" },
  { id: "sport", label: "Sport" },
] as const;

export type FitnessSectionId = (typeof FITNESS_SECTIONS)[number]["id"];

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

export interface FitnessWindow {
  /** Inclusive first day, or null for an all-time window. */
  from: string | null;
  /** Inclusive last day — the range's end, or today when it is open-ended. */
  to: string;
  /** Window length in inclusive days, or null for all time. */
  days: number | null;
  /** True when the hub's range names no window at all ("All time"). */
  allTime: boolean;
}

// Resolve the hub's DateRange into the concrete window every Fitness builder reads.
// A half-open range is honored as given: `from` with no `to` runs to today, `to`
// with no `from` is open at the start (all-time up to that day) — the same
// semantics the other tabs' series filters use.
export function fitnessWindow(
  range: DateRange,
  todayStr: string
): FitnessWindow {
  const from = range.from ?? null;
  const to = range.to ?? todayStr;
  const spanned = from ? daysBetweenDateStr(from, to) : null;
  // An unparseable date (never produced by the hub, which validates its params)
  // degrades to all time rather than a NaN-length window.
  const days = spanned == null ? null : Math.max(1, spanned + 1);
  return {
    from: days == null ? null : from,
    to,
    days,
    allTime: !range.from && !range.to,
  };
}

// The widest heatmap a window may draw: ~12 months (53 columns is a hair over a
// year, so a trailing 12 months is always fully visible). All time CAPS here —
// unchanged from the pre-#1492 grid — rather than growing without bound.
export const MAX_FITNESS_WEEKS = 53;
// The narrowest: below about a month of columns the weekly charts have too few
// bars to read as a trend, so a very short window still draws a month of context.
export const MIN_FITNESS_WEEKS = 4;

// How many week columns a window is worth. 90D → 13 weeks (the default window's
// heatmap is a quarter, not a year); all time → the 12-month cap.
export function fitnessWindowWeeks(days: number | null): number {
  if (days == null) return MAX_FITNESS_WEEKS;
  const weeks = Math.ceil(days / 7);
  return Math.min(MAX_FITNESS_WEEKS, Math.max(MIN_FITNESS_WEEKS, weeks));
}

// The `withinDays` a PR engine needs to mean "set inside this window". The engines
// take (stats, today, withinDays) and keep records whose date is within that many
// days BACK from `today`, so the window's end is the anchor and its length is the
// reach. An all-time window reaches back further than any stored record can.
export const ALL_TIME_PR_DAYS = 100 * 365;

export function windowPrDays(window: FitnessWindow): number {
  return window.days ?? ALL_TIME_PR_DAYS;
}

// ---------------------------------------------------------------------------
// "PRs this window"
// ---------------------------------------------------------------------------

// The tab's compact PR block: the top few records SET inside the window, across
// both disciplines, with the full list one link away on /training. Replaces the
// 14-row "Recent PRs" + "Recent cardio PRs" pair the tab used to stack above every
// chart (the audit's ~900px pre-chart wall).
export type WindowPR =
  | { source: "strength"; date: string; pr: PR }
  | { source: "cardio"; date: string; pr: CardioPR };

export interface WindowPRs {
  /** Newest first, capped at `limit`. */
  items: WindowPR[];
  /** How many records fell in the window in total (drives "show all"). */
  total: number;
}

// The compact block's size — the "movers" treatment (#1485/#1490): three rows,
// then a link.
export const WINDOW_PR_LIMIT = 3;

// Merge the two engines' already-windowed outputs into one newest-first list and
// take the top `limit`. Ties (two records on the same date) are broken
// deterministically — strength before cardio, then by name, then by kind — so a
// re-render can never shuffle the three rows a user just read.
export function selectWindowPRs(
  strength: PR[],
  cardio: CardioPR[],
  limit: number = WINDOW_PR_LIMIT
): WindowPRs {
  const all: WindowPR[] = [
    ...strength.map((pr): WindowPR => ({
      source: "strength",
      date: pr.date,
      pr,
    })),
    ...cardio.map((pr): WindowPR => ({ source: "cardio", date: pr.date, pr })),
  ];
  all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.source !== b.source) return a.source === "strength" ? -1 : 1;
    const an = windowPRName(a);
    const bn = windowPRName(b);
    if (an !== bn) return an < bn ? -1 : 1;
    return a.pr.kind < b.pr.kind ? -1 : a.pr.kind > b.pr.kind ? 1 : 0;
  });
  return { items: all.slice(0, Math.max(0, limit)), total: all.length };
}

// The exercise / activity a windowed PR belongs to.
export function windowPRName(item: WindowPR): string {
  return item.source === "strength" ? item.pr.exercise : item.pr.activity;
}

// ---------------------------------------------------------------------------
// PR rate
// ---------------------------------------------------------------------------

export interface PrWeek {
  /** Week-start date (the profile's configured first weekday). */
  week: string;
  count: number;
}

// Records per week across the window — the "PR rate" trend. A pure roll-up of the
// SAME windowed records the block above lists (not a second detection pass), zero-
// filled across every week in the window so a barren stretch reads as empty bars
// rather than compressing away (#406).
export function prWeeks(
  records: WindowPR[],
  weeks: string[] // week-start dates, oldest → newest
): PrWeek[] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  const out: PrWeek[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const start = weeks[i];
    const end = i + 1 < weeks.length ? weeks[i + 1] : null;
    let count = 0;
    for (const [date, n] of counts) {
      if (date >= start && (end == null || date < end)) count += n;
    }
    out.push({ week: start, count });
  }
  return out;
}

// The week-start dates spanning [firstWeekStart, to], oldest → newest. Callers
// resolve `firstWeekStart` through the profile's week-start setting.
export function weekStartsThrough(
  firstWeekStart: string,
  to: string
): string[] {
  const out: string[] = [];
  let cur = firstWeekStart;
  while (cur <= to) {
    out.push(cur);
    cur = shiftDateStr(cur, 7);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strength movers
// ---------------------------------------------------------------------------

export interface StrengthMover {
  exercise: string;
  first: number;
  last: number;
  deltaKg: number;
  points: number;
}

// Windowed estimated-1RM movement per lift: where each lift's e1RM series started
// and ended INSIDE the window, ranked by the size of the move. The series come
// from getExerciseE1rmSeries, already collapsed onto the canonical
// `exerciseHistoryKey` (#331/#432/#482) — a lift and its variants are ONE mover,
// never two half-series that each look flat.
//
// A lift needs at least two windowed sessions to have moved at all; one session is
// a data point, not a trend.
export function strengthMovers(
  series: { exercise: string; points: { date: string; value: number }[] }[],
  limit = 5
): StrengthMover[] {
  const movers: StrengthMover[] = [];
  for (const s of series) {
    if (s.points.length < 2) continue;
    const first = s.points[0].value;
    const last = s.points[s.points.length - 1].value;
    movers.push({
      exercise: s.exercise,
      first,
      last,
      deltaKg: last - first,
      points: s.points.length,
    });
  }
  movers.sort(
    (a, b) =>
      Math.abs(b.deltaKg) - Math.abs(a.deltaKg) ||
      b.points - a.points ||
      (a.exercise < b.exercise ? -1 : 1)
  );
  return movers.slice(0, limit);
}
