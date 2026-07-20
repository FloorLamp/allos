// Month adherence calendar (issue #852 item 5) — a PURE formatter over the EXISTING
// adherence data (an AdherenceDot[] over a month's dates, oldest-first and contiguous,
// built by the same supplementAdherenceStrip the 14-day strip uses; no new model). It
// lays the daily taken/partial/skipped/missed/not-due states out on a Sun→Sat calendar
// grid so the med's detail page can show the month-scale picture the strip can't.

import type { AdherenceDot, AdherenceState } from "./supplement-adherence";

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

// UTC-anchored weekday (0=Sun…6=Sat) of a YYYY-MM-DD date — matches shiftDateStr's
// UTC anchoring so the grid never drifts across a DST boundary.
function weekday(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

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

  const cells: AdherenceCalendarCell[] = [];
  if (visibleDots.length > 0) {
    // Pad the first partial week with blanks up to the first day's weekday.
    const lead = weekday(visibleDots[0].date);
    for (let i = 0; i < lead; i++) cells.push({ date: null, state: null });
    for (const d of visibleDots) cells.push({ date: d.date, state: d.state });
    // Pad the final partial week so every row is 7 wide.
    while (cells.length % 7 !== 0) cells.push({ date: null, state: null });
  }

  const weeks: AdherenceCalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return { weeks, counts };
}
