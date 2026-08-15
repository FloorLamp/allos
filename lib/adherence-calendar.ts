// Month adherence calendar (issue #852 item 5) — a PURE formatter over the EXISTING
// adherence data (an AdherenceDot[] over a month's dates, oldest-first and contiguous,
// built by the same intakeAdherenceStrip the 14-day strip uses; no new model). It
// lays the daily taken/partial/skipped/missed/not-due states out on a Sun→Sat calendar
// grid so the med's detail page can show the month-scale picture the strip can't.

import { dayGrid } from "./day-grid";
import {
  trailingPendingIndex,
  type AdherenceDot,
  type AdherenceState,
} from "./intake-adherence";

// The calendar's own vocabulary: the strip's states plus "pending" (issue #2796).
//
// Today is not a settled day. Its due dose scores "missed" in the strip simply because
// nothing is logged yet, and the calendar was painting that as a red Missed cell while
// the TODAY block on the same page still offered "Mark taken" — today cannot be both,
// and the legend's missed count was one too high all day, every day.
//
// The percentage's answer to this is to DROP the day (stripWithoutTrailingPending). A
// calendar cannot: a month grid with today missing reads as broken. So the same guard
// is applied here as a distinct state — neutral, counted on its own line — rather than
// as a deletion. "pending" exists only at this layer; the strip, the summary and the
// pattern detectors keep the four states they had.
export type AdherenceCalendarState = AdherenceState | "pending";

export interface AdherenceCalendarCell {
  // null on a padding cell before the first / after the last day of the range.
  date: string | null;
  state: AdherenceCalendarState | null;
}

export interface AdherenceCalendarModel {
  // Each inner array is exactly 7 cells (Sunday → Saturday). Leading/trailing padding
  // cells carry null so the grid is rectangular.
  weeks: AdherenceCalendarCell[][];
  // Tally of the real (non-padding) days by state, for a legend/summary. "na" days
  // (not due) are counted too so the reader knows why a day is blank.
  counts: Record<AdherenceCalendarState, number>;
}

// An ADAPTER over the shared `dayGrid` (#2042), which replaced this module's local
// UTC weekday helper and its hand-rolled lead/trail padding. `null` cells are the
// grid's `before`/`after` padding under this domain's older name: a calendar page
// renders them blank rather than as dates outside the course.
export function buildAdherenceCalendar(
  dots: AdherenceDot[],
  startedOn: string | null = null
): AdherenceCalendarModel {
  // A fixed lookback window can extend before the medication existed. Those days
  // are outside the course—not missed and not merely "not due"—so omit them from
  // both the visible calendar and its legend counts.
  const visibleDots = startedOn
    ? dots.filter((dot) => dot.date >= startedOn)
    : dots;
  // The trailing still-pending day, from the ONE shared guard. `dots` ends at the
  // profile's today (see trailingPendingIndex), and the startedOn filter only ever
  // trims from the FRONT, so the index is read off the visible window.
  const pendingIndex = trailingPendingIndex(visibleDots);
  const stateAt = (i: number): AdherenceCalendarState =>
    i === pendingIndex ? "pending" : visibleDots[i].state;

  const counts: Record<AdherenceCalendarState, number> = {
    taken: 0,
    partial: 0,
    skipped: 0,
    missed: 0,
    pending: 0,
    na: 0,
  };
  for (let i = 0; i < visibleDots.length; i++) counts[stateAt(i)]++;

  if (visibleDots.length === 0) return { weeks: [], counts };

  const byDate = new Map(
    visibleDots.map((dot, i) => [dot.date, stateAt(i)] as const)
  );
  // Sun→Sat rows over the dots' own span. weekStart 0 is this surface's fixed
  // choice: a month calendar is a conventional layout, not a per-profile one.
  const grid = dayGrid({
    start: visibleDots[0].date,
    end: visibleDots[visibleDots.length - 1].date,
    weekStart: 0,
    orientation: "week-rows",
  });
  const weeks: AdherenceCalendarCell[][] = grid.weeks.map((row) =>
    row.map((cell) =>
      cell.position === "in-window"
        ? { date: cell.date, state: byDate.get(cell.date) ?? null }
        : { date: null, state: null }
    )
  );

  return { weeks, counts };
}
