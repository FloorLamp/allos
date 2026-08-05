// ONE calendar-grid builder (#2042). "Lay dated counts on a 7×N grid" was written
// three times — the workout heatmap (week columns, `future` padding, month labels),
// the protocol heatmap (week columns, `outside` padding, 53-week truncation) and the
// month adherence calendar (Sun→Sat rows, `null` padding, its own local weekday
// helper). Three padding vocabularies for one concept, and three copies of the same
// week arithmetic that had to be edited in lockstep.
//
// The level/color axis had already converged (protocol-heatmap imports
// `intensityLevel` from workout-heatmap; practice-heatmap is a thin delegate over
// buildProtocolHeatmap). This is the grid math following it.
//
// Deliberately payload-free: `dayGrid` decides WHICH DAY sits in which cell and
// whether that day is inside the caller's window. The domain payload (counts,
// minutes, adherence states) and the level function stay with the caller, which is
// why one builder can serve three unrelated domains without growing a union type.
//
// All arithmetic is UTC-anchored calendar math (shiftDateStr / startOfWeekStr), so
// it is DST-immune and timezone-independent.

import {
  daysBetweenDateStr,
  monthNames,
  shiftDateStr,
  startOfWeekStr,
} from "./date";

// Where a cell's day sits relative to the caller's [start, end] window. ONE
// vocabulary replacing `future` / `outside` / `null`: a padding cell is not a
// nameless blank, it is a real day the window does not cover, and the two sides are
// distinguishable because they mean different things (a day before a protocol began
// is not the same as a day that has not happened yet).
export type DayGridPosition = "in-window" | "before" | "after";

export interface DayGridCell {
  /** YYYY-MM-DD. Every cell carries a real date, padding included. */
  date: string;
  position: DayGridPosition;
}

// Which axis the caller renders weeks on. The GROUPING is the same either way —
// a week is seven consecutive days from the week-start day — which is precisely
// why three independent implementations agreed on the math and only disagreed
// about vocabulary. The value is echoed back so the renderer reads it off the
// model instead of re-deciding it.
export type DayGridOrientation = "week-columns" | "week-rows";

export interface DayGridOptions {
  /** Inclusive first day of the caller's window. */
  start: string;
  /** Inclusive last day of the caller's window. */
  end: string;
  /** 0=Sun … 6=Sat — the profile's first weekday. */
  weekStart?: number;
  orientation?: DayGridOrientation;
  /**
   * Cap the grid at this many weeks, keeping the MOST RECENT ones (a truncated
   * grid drops old history, never the present). Omitted = no cap.
   */
  maxWeeks?: number;
}

export interface DayGridModel {
  /** Weeks oldest→newest, each exactly 7 cells in week order. */
  weeks: DayGridCell[][];
  orientation: DayGridOrientation;
  /** The grid's own first day — the week start on or before `start`, or later when truncated. */
  gridStart: string;
  /** The grid's own last day — the last cell, which may run past `end`. */
  gridEnd: string;
  /** The caller's window, echoed. */
  start: string;
  end: string;
  /** The first day actually visible: `start`, or the grid start when truncation cut into the window. */
  visibleStart: string;
  weekCount: number;
  /** True when `maxWeeks` cut weeks off the front. */
  truncated: boolean;
}

// The number of week columns spanning [start, end] inclusive, week-aligned.
export function weekSpan(start: string, end: string, weekStart = 0): number {
  const firstWeek = startOfWeekStr(start, weekStart);
  const lastWeek = startOfWeekStr(end, weekStart);
  const days = daysBetweenDateStr(firstWeek, lastWeek);
  return Math.max(1, Math.floor((days ?? 0) / 7) + 1);
}

// The top-left cell date of a `weeks`-wide grid whose LAST week contains `end`.
export function gridStartFor(end: string, weeks: number, weekStart = 0): string {
  return shiftDateStr(startOfWeekStr(end, weekStart), -(weeks - 1) * 7);
}

// Lay the days of [start, end] onto a rectangular 7×N grid. Cells outside the
// window are `before`/`after` padding — they still carry their real date, so a
// caller that wants to render one (a hover title, a debug view) can, and a caller
// that wants a blank simply checks `position`.
export function dayGrid(options: DayGridOptions): DayGridModel {
  const {
    start,
    end,
    weekStart = 0,
    orientation = "week-columns",
    maxWeeks,
  } = options;
  const fullWeeks = weekSpan(start, end, weekStart);
  const weekCount =
    maxWeeks == null ? fullWeeks : Math.min(fullWeeks, Math.max(1, maxWeeks));
  const truncated = weekCount < fullWeeks;
  const gridStart = truncated
    ? gridStartFor(end, weekCount, weekStart)
    : startOfWeekStr(start, weekStart);

  const weeks: DayGridCell[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const cells: DayGridCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = shiftDateStr(gridStart, w * 7 + d);
      cells.push({
        date,
        position: date < start ? "before" : date > end ? "after" : "in-window",
      });
    }
    weeks.push(cells);
  }

  return {
    weeks,
    orientation,
    gridStart,
    gridEnd: shiftDateStr(gridStart, weekCount * 7 - 1),
    start,
    end,
    visibleStart: gridStart < start ? start : gridStart,
    weekCount,
    truncated,
  };
}

// A month label above the first week whose FIRST cell enters a new month — the
// heatmap's column header rule, kept here so it rides the grid it labels.
export function dayGridMonthLabels(
  grid: DayGridModel
): { col: number; label: string }[] {
  const months = monthNames("short");
  const labels: { col: number; label: string }[] = [];
  let prev = -1;
  grid.weeks.forEach((cells, col) => {
    const month = Number(cells[0].date.slice(5, 7)) - 1;
    if (month !== prev) {
      labels.push({ col, label: months[month] });
      prev = month;
    }
  });
  return labels;
}
