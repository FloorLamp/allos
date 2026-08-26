// Windowed fitness computations introduced for Trends → Fitness by #1492 and kept
// after that tab retired into Training → Analyze (#3512). What survives is what
// Analyze, Workout history and Zones & cardio actually import:
//   • the window itself (`fitnessWindow`) — the hub's DateRange resolved to a
//     concrete [from, to] plus its length in days (null = all time),
//   • how many WEEK columns a window is worth (`fitnessWindowWeeks`) — the heatmap
//     and the weekly zone/cardio charts all scope by week count,
//   • whether Zones & cardio has anything to draw (`hasFitnessZoneContent`).
//
// The retired volume, PR, sport and aggregate-strength computations that used to
// sit below these were deleted in #3734. They outlived their mounts by one tab
// retirement and were held up only by their own tests, which is not a caller. If a
// windowed PR block ever returns, it reuses `recentPRs` / `recentCardioPRs` in
// lib/coaching with a window parameter (#221) rather than forking a second engine
// — that rule is why this module never detected records in the first place.

import type { DateRange } from "./timeline-format";
import { clampLensWeeks, lensWindow, type LensWeekCaps } from "./trends";

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

// This lens's week-column caps. Only the CAPS are the lens's own decision; the
// anchor rule that turns a DateRange into a window belongs to `lensWindow` and is
// shared with every other lens on the hub (#2043).
const FITNESS_WEEK_CAPS: LensWeekCaps = {
  minWeeks: 4,
  maxWeeks: 53,
};

// Resolve the hub's DateRange into the concrete window every Fitness builder reads.
// A half-open range is honored as given: `from` with no `to` runs to today, `to`
// with no `from` is open at the start (all-time up to that day) — the same
// semantics the other tabs' series filters use. The end never runs past today: an
// analytics window cannot describe days that have not happened, and before #2043
// this lens was the only one on the hub that let it.
export function fitnessWindow(
  range: DateRange,
  todayStr: string
): FitnessWindow {
  const { from, to, days, allTime } = lensWindow(
    range,
    todayStr,
    FITNESS_WEEK_CAPS
  );
  return { from, to, days, allTime };
}

// How many week columns a window is worth. 90D → 13 weeks (the default window's
// heatmap is a quarter, not a year); all time → the 12-month cap.
export function fitnessWindowWeeks(days: number | null): number {
  return clampLensWeeks(days, FITNESS_WEEK_CAPS);
}

// Zones & cardio is data-gated rather than standing Analyze chrome. The server
// component calls this immediately after its zone-model read and before gathering
// either cardio aggregate, so an absent model or an empty zone split ends the
// render without paying for data whose JSX would be discarded.
export function hasFitnessZoneContent(data: {
  model: unknown | null;
  split: { totalMin: number };
}): boolean {
  return data.model != null && data.split.totalMin > 0;
}
