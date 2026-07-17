// Time-axis placement for protocol intervention windows (issue #660). PURE — maps
// each TrendWindow's [start, end] to the epoch x1/x2 a recharts ReferenceArea needs
// on a NUMERIC time axis (the biomarker-detail + Compare charts), clamped to the
// charted date extent and dropping windows with no overlap. Category-axis charts
// use snapWindowsToDates in lib/trend-annotations instead; both are the same
// "shade the window" idea specialized to each axis type. Unit-tested.

import { dateToEpoch } from "./chart-time-axis";
import type { TrendWindow } from "./trend-annotations";

export interface ChartWindowEpoch {
  x1: number;
  x2: number;
  label: string;
}

// Clamp each window to the [min, max] epoch of the charted dates. An ongoing window
// (end null) extends to the last charted date. Windows that fall entirely outside
// the charted extent — or collapse to zero width after clamping — are dropped.
export function protocolWindowEpochs(
  windows: readonly TrendWindow[],
  dates: readonly string[]
): ChartWindowEpoch[] {
  if (dates.length === 0) return [];
  let firstEpoch = Infinity;
  let lastEpoch = -Infinity;
  for (const d of dates) {
    const e = dateToEpoch(d);
    if (e < firstEpoch) firstEpoch = e;
    if (e > lastEpoch) lastEpoch = e;
  }
  const out: ChartWindowEpoch[] = [];
  for (const w of windows) {
    const start = dateToEpoch(w.start);
    const end = w.end ? dateToEpoch(w.end) : lastEpoch;
    if (start > lastEpoch || end < firstEpoch) continue; // no overlap
    const x1 = Math.max(start, firstEpoch);
    const x2 = Math.min(end, lastEpoch);
    if (x1 >= x2) continue; // collapsed to a zero-width span
    out.push({ x1, x2, label: w.label });
  }
  return out;
}
