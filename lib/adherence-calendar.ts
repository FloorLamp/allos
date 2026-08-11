// Month adherence calendar (issue #852 item 5) — a PURE formatter over the EXISTING
// adherence data (an AdherenceDot[] over a month's dates, oldest-first and contiguous,
// built by the same intakeAdherenceStrip the 14-day strip uses; no new model). It
// lays the daily taken/partial/skipped/missed/not-due states out on a Sun→Sat calendar
// grid so the med's detail page can show the month-scale picture the strip can't.

import { dayGrid } from "./day-grid";
import type { AdherenceDot, AdherenceState } from "./intake-adherence";

export interface AdherenceCalendarCell {
  // null on a padding cell before the first / after the last day of the range.
  date: string | null;
  state: AdherenceState | null;
}

export interface AdherenceCalendarModel {
  // Each inner array is exactly 7 cells (Sunday → Saturday). Leading/trailing padding
  // cells carry null so the grid is rectangular.
  weeks: AdherenceCalendarCell[][];
  // Tally of the real (non-padding) days by state, for a legend/summary. "na" days
  // (not due) are counted too so the reader knows why a day is blank.
  counts: Record<AdherenceState, number>;
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
  const counts: Record<AdherenceState, number> = {
    taken: 0,
    partial: 0,
    skipped: 0,
    missed: 0,
    na: 0,
  };
  for (const d of visibleDots) counts[d.state]++;

  if (visibleDots.length === 0) return { weeks: [], counts };

  const byDate = new Map(visibleDots.map((dot) => [dot.date, dot.state]));
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
