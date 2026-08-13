// THE ANNUAL RETROSPECTIVE (issue #2179) — the PURE half: which year, over which
// window, and how honest the page has to be about what that window actually covers.
//
// The owner ruling this implements, in one line: yearly is deliberately NOT a cadence
// tier of the periodic review (#2178) — a profile whose only review arrives every
// twelve months has no review, and a year does not fit in a message — so the annual
// digest is a RENDERED SURFACE. This module owns the surface's window arithmetic; the
// line model is the recap engine's, unchanged, at `scale: "year"`.
//
// ── ONE COMPUTATION, RE-PRESENTED ────────────────────────────────────────────────
//
// Nothing here derives a health fact. The retrospective's numbers are `buildRecap`'s
// numbers over `recapPeriod("year", …)`, which is the same engine, the same period
// arithmetic and the same per-line declarations the weekly card and the monthly send
// already read. A second derivation that disagreed with the dashboard would be the
// worst outcome this feature could have, so there isn't one: what this module computes
// is a YEAR and a WINDOW, and what it states is what that window covers.
//
// ── USER-INITIATED, AND THAT IS THE WHOLE POSTURE ────────────────────────────────
//
// Under the attention doctrine (`docs/internals/findings.md`) this is a user-initiated
// surface: you go to it. It produces no `Finding`, mints no dedupe key, never reaches
// Upcoming, and sends nothing. The issue's pointer send ("your 2026 year in review is
// ready") is a contact INCREASE that stacks beside the chosen review cadence, so it
// needs its own toggle and its own decision — it is deliberately not built in this
// slice. Nothing here should acquire one by accident: if this module ever grows a
// marker, a dedupe key or a `notify_` constant, the posture has changed.
//
// ── #2385: HOW THIS FEATURE WOULD LEARN IT SHOULD STOP ───────────────────────────
//
// The retrospective claims to change behaviour only in the mildest sense — it offers a
// once-a-year artifact people choose to look at — but it still owes the triple, as
// prose, over data the instance already holds. No telemetry, no score, no registry.
//
//   WHAT WOULD SHOW IT WORKING. Profiles that open a retrospective keep logging at the
//   same rate afterwards as before it, and the year's line set is mostly POPULATED —
//   a retrospective whose lines are mostly absent is a page about missing data.
//
//   WHAT WOULD SHOW IT WRONG. A retrospective that reads as a report card: opened once
//   and never again while data keeps arriving, or opened and followed by a DROP in
//   logging in the weeks after — the reaction "I did worse than I thought" is exactly
//   the verdict the commemorative exemption exists to avoid producing.
//
//   ITS DECEPTIVE SUCCESS. Page opens rising while the population of profiles with a
//   populated year SHRINKS. A retrospective is most compelling to the person who
//   logged the most, so a surface that quietly becomes a reward for heavy loggers can
//   look increasingly popular while serving fewer and fewer people — the same shape as
//   food coverage rising while servings-per-window falls. Counting opens would measure
//   the wrong half; the honest local question is how many profiles have a year worth
//   rendering at all, which is `retrospectiveCoverage` answered across the roster.

import { isoDate, shiftDateStr } from "./date";
import { formatMonthDay, type DisplayFormatPrefs } from "./format-date";

/** The calendar year a date string falls in. */
export function yearOf(dateStr: string): number {
  return Number(dateStr.slice(0, 4));
}

/** Jan 1 of `year`, as a YYYY-MM-DD string. */
export function yearStart(year: number): string {
  return isoDate(year, 0, 1);
}

/** Dec 31 of `year`, as a YYYY-MM-DD string. */
export function yearEnd(year: number): string {
  return shiftDateStr(isoDate(year + 1, 0, 1), -1);
}

/**
 * How the recap engine should be asked for `year`.
 *
 * The engine already resolves a scale's period from a date and a `completed` flag, so
 * the retrospective does not need a second window model — it needs to know which date
 * to ask ON. A CLOSED year is asked on the first day of the year after it with
 * `completed: true`; the year still running is asked on today with `completed: false`,
 * which yields Jan 1 → today and the whole prior year as the comparison. Either way the
 * period, the gather and the lines come from one place.
 *
 * A year in the future has no window: it is clamped to the current year, because the
 * only way to ask for one is a hand-edited URL.
 */
export interface RetrospectiveWindow {
  year: number;
  /** The date the gather and `buildRecap` treat as "today". */
  asOf: string;
  /** The engine's completed-period flag: true for a year that has closed. */
  completed: boolean;
  /** True while the year is still running — the page says so rather than implying a full year. */
  inProgress: boolean;
}

export function retrospectiveWindow(
  year: number,
  today: string
): RetrospectiveWindow {
  const current = yearOf(today);
  const y = Math.min(year, current);
  return y < current
    ? { year: y, asOf: yearStart(y + 1), completed: true, inProgress: false }
    : { year: y, asOf: today, completed: false, inProgress: true };
}

/**
 * The years the picker offers, newest first: every calendar year from the profile's
 * first logged day through the current one.
 *
 * The current year is ALWAYS offered, even for a profile with nothing logged — an empty
 * retrospective is a legitimate answer ("nothing yet"), and a picker with no options is
 * a broken page rather than an honest one.
 */
export function retrospectiveYears(
  firstDay: string | null,
  today: string
): number[] {
  const current = yearOf(today);
  const first = firstDay ? Math.min(yearOf(firstDay), current) : current;
  const out: number[] = [];
  for (let y = current; y >= first; y--) out.push(y);
  return out;
}

/**
 * Resolve a `?year=` parameter against the offered years. Anything unparseable, out of
 * range, or simply absent lands on the newest offered year — the page a person means
 * when they follow a bare link.
 */
export function resolveRetrospectiveYear(
  raw: string | null | undefined,
  years: readonly number[]
): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && years.includes(parsed)
    ? parsed
    : (years[0] ?? yearOf(isoDate(1970, 0, 1)));
}

/**
 * WHAT THE WINDOW ACTUALLY COVERS — the honest partial-first-year handling the issue
 * asks for, as facts rather than as a sentence.
 *
 * Two independent truncations, and a year can suffer both: data may have STARTED inside
 * the year (the profile's first logged day), and the year may not have FINISHED. The
 * page must not print "your 2026" over eleven weeks of March-onward data and let the
 * counts imply twelve months.
 *
 * Deliberately NOT a re-cut of the recap window. The engine still computes over the
 * whole calendar year — a sum over Jan 1 → Dec 31 and a sum over Mar 3 → Dec 31 are the
 * same number when there is nothing before March 3 — so this is a STATEMENT about the
 * period, not a second period. Clamping the window would fork the engine to say
 * something the engine already says correctly.
 */
export interface RetrospectiveCoverage {
  year: number;
  /** The first day of the year with data behind it: Jan 1, or the profile's first day. */
  from: string;
  /** The last day the window can speak for: Dec 31, or today. */
  through: string;
  /** True when the profile's data BEGAN inside this year. */
  partialStart: boolean;
  /** True when the year has not closed yet. */
  inProgress: boolean;
}

export function retrospectiveCoverage(
  year: number,
  firstDay: string | null,
  today: string
): RetrospectiveCoverage {
  const start = yearStart(year);
  const end = yearEnd(year);
  const partialStart = firstDay != null && firstDay > start && firstDay <= end;
  const inProgress = today >= start && today <= end;
  return {
    year,
    from: partialStart && firstDay ? firstDay : start,
    through: inProgress ? today : end,
    partialStart,
    inProgress,
  };
}

/**
 * The coverage sentence, or null when the year is whole and closed and there is nothing
 * to qualify. ONE wording for the page and for anything that later quotes it.
 */
export function retrospectiveCoverageSentence(
  coverage: RetrospectiveCoverage,
  prefs: DisplayFormatPrefs
): string | null {
  const from = formatMonthDay(coverage.from, prefs);
  const through = formatMonthDay(coverage.through, prefs);
  if (coverage.partialStart && coverage.inProgress)
    return `Since ${from}, when your data begins, through ${through} — this year is still running.`;
  if (coverage.partialStart)
    return `Since ${from}, when your data begins — the year before that is not yours to compare against.`;
  if (coverage.inProgress)
    return `January 1 through ${through} — this year is still running.`;
  return null;
}
