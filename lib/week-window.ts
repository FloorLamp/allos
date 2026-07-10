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
