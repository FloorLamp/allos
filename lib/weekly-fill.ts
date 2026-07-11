// Weekly bar-chart week-axis helpers (issue #406). A category BarChart that only
// renders weeks WITH data compresses training GAPS away — a January bar and a May
// bar sit adjacent, reading as continuous training, and a Zone-2 target reference
// line then implies adherence over weeks that were actually zero-minute. These pure
// helpers expand a set of data-weeks into the contiguous week axis the chart should
// render, so a gap shows as empty bars. No DB / no React — client-safe, unit-tested.

import { shiftDateStr } from "./date";

// Every week-start (inclusive) from `first` to `last`, stepping 7 days. Both must
// already be week-start-aligned YYYY-MM-DD (same weekStart convention). Empty when
// last < first. Pure calendar arithmetic (shiftDateStr is UTC-anchored).
export function weekStartsInclusive(first: string, last: string): string[] {
  if (last < first) return [];
  const out: string[] = [];
  let w = first;
  // Guard against a non-week-aligned pair looping forever: at most ~10 years.
  for (let i = 0; w <= last && i < 600; i++) {
    out.push(w);
    w = shiftDateStr(w, 7);
  }
  return out;
}

// The contiguous week-start axis a weekly BAR chart should render: every week from
// the window start to the latest data week, so a gap renders as empty bars.
// `dataWeeks` are the week-starts that HAVE data (any order); `windowWeeks` bounds
// how many weeks back from the latest to show. Weeks before the FIRST data week are
// trimmed (no leading empties before training ever started). Empty when no data.
export function weeklyChartWeeks(
  dataWeeks: string[],
  windowWeeks: number
): string[] {
  if (dataWeeks.length === 0) return [];
  const sorted = [...dataWeeks].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let windowStart = last;
  for (let i = 1; i < windowWeeks; i++)
    windowStart = shiftDateStr(windowStart, -7);
  const start = windowStart > first ? windowStart : first;
  return weekStartsInclusive(start, last);
}
