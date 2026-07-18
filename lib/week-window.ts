// The ONE definition of "this week" (issue #223). A profile's `week_mode` decides
// what "this week" means, and every surface that shows a weekly window — the
// weekly-routine counters, the journal week summary, and the weekly recap
// (dashboard card + Telegram notification) — derives its window from here, so they
// all count the same days. Pure calendar arithmetic (UTC-anchored, DST-immune) on
// YYYY-MM-DD strings; no DB/network, so it runs in the query layer, the notify
// sidecar, and the unit tests alike.

import { shiftDateStr, startOfWeekStr } from "./date";
import type { WeekMode, WeekStart } from "./settings"; // type-only: erased, no cycle

// The inclusive current-week window [start, end] ending on `today`, plus the
// immediately-preceding full-7-day comparison window [prevStart, prevEnd].
export interface WeekWindow {
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
}

// Resolve `today`'s week window for the given mode:
//   - "rolling":  a trailing 7 days ending on `today` (start = today − 6).
//   - "calendar": the calendar week CONTAINING `today` (from `weekStart`), from its
//                 week-start day through `today` — the same in-progress, possibly
//                 partial week the routine counters show (they filter `date >=`
//                 this start). The comparison window is the preceding full 7 days
//                 in both modes.
// `weekStart` (0=Sun … 6=Sat) only matters in calendar mode.
export function weekWindow(
  today: string,
  mode: WeekMode,
  weekStart: WeekStart = 0
): WeekWindow {
  const start =
    mode === "rolling"
      ? shiftDateStr(today, -6)
      : startOfWeekStr(today, weekStart);
  return {
    start,
    end: today,
    prevStart: shiftDateStr(start, -7),
    prevEnd: shiftDateStr(start, -1),
  };
}

// One week in a trailing series (issue #954): its inclusive [start, end] window and
// whether it's the current (in-progress) week. Same "week" definition as weekWindow
// (#223), so the trend's current-week cell and the this-week progress can't drift.
export interface TrailingWeek {
  start: string;
  end: string;
  isCurrent: boolean;
}

// The trailing `n` weeks ending with the current (possibly partial) week, OLDEST
// FIRST — the render order for a left-to-right consistency strip. Week identity
// follows the profile's mode/weekStart via weekWindow: index 0 is the current week
// [start, today] (in-progress), and each earlier week is a full 7-day block anchored
// 7·k days before the current start. Pure calendar arithmetic (UTC-anchored,
// DST-immune) so it runs in the query layer and the unit tests alike.
export function trailingWeeks(
  today: string,
  mode: WeekMode,
  weekStart: WeekStart,
  n: number
): TrailingWeek[] {
  const cur = weekWindow(today, mode, weekStart);
  const weeks: TrailingWeek[] = [];
  for (let k = 0; k < n; k++) {
    const start = shiftDateStr(cur.start, -7 * k);
    weeks.push({
      start,
      end: k === 0 ? today : shiftDateStr(start, 6),
      isCurrent: k === 0,
    });
  }
  return weeks.reverse(); // oldest first
}
