// The N-of-1 protocol comparison engine (issue #161). PURE — no DB, no network,
// no clock. For each declared outcome metric it compares a BASELINE window (the
// equal-length span immediately before the protocol started) against the
// INTERVENTION window (start..end, or start..today for an ongoing protocol) and
// reports an honest mean/median shift with the n per window. Deliberately NO
// p-values / significance theater: a single person's before/during readings are
// descriptive, not inferential, so the framing states the shift and the counts
// and lets the reader judge.
//
// Window boundaries are calendar dates (YYYY-MM-DD); the caller passes `today`
// already resolved in the profile's timezone (the tz-window convention — see
// lib/date), so this file never touches a real clock and stays deterministic.

import { daysBetweenDateStr, shiftDateStr } from "./date";
import type { OutcomeDirection } from "./protocol-metrics";

export interface OutcomeSample {
  date: string; // YYYY-MM-DD
  value: number;
}

// One outcome metric's inputs: its identity + the full sample series (any order;
// the engine filters and sorts). `direction` governs the good/bad verdict.
export interface OutcomeSeries {
  key: string;
  label: string;
  unit?: string | null;
  direction?: OutcomeDirection;
  samples: OutcomeSample[];
}

export interface WindowRange {
  start: string;
  end: string;
}

export interface WindowStats {
  n: number;
  mean: number | null;
  median: number | null;
  // The dates actually contributing (for the "nearest draw" fallback, this may be
  // a single date outside the nominal window).
  from: string | null;
  to: string | null;
}

export type Betterness = "better" | "worse" | "unchanged" | "unknown";

export interface OutcomeComparison {
  key: string;
  label: string;
  unit: string | null;
  direction: OutcomeDirection;
  baseline: WindowStats;
  intervention: WindowStats;
  meanDelta: number | null;
  medianDelta: number | null;
  betterness: Betterness;
  // True when either window has no reading — the shift can't be computed.
  insufficient: boolean;
  // A one-line, honest description ("Resting heart rate −3.2 bpm vs the 8 weeks
  // prior (n=42 during vs 40 before)"), or an insufficient-data note.
  framing: string;
}

export interface ProtocolComparison {
  interventionWindow: WindowRange;
  baselineWindow: WindowRange;
  // The inclusive length (days) of each window.
  spanDays: number;
  outcomes: OutcomeComparison[];
}

export interface CompareOptions {
  startDate: string; // protocol start (YYYY-MM-DD)
  endDate: string | null; // null = ongoing
  today: string; // YYYY-MM-DD in the profile's timezone
  // When a metric's baseline window catches no reading but an earlier reading
  // exists, use the single nearest reading before the start as the baseline
  // (the "nearest draw before" rule for sparse labs). Default true.
  baselineNearestFallback?: boolean;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function statsFor(samples: OutcomeSample[]): WindowStats {
  const sorted = [...samples].sort((a, b) => a.date.localeCompare(b.date));
  const values = sorted.map((s) => s.value);
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    from: sorted.length ? sorted[0].date : null,
    to: sorted.length ? sorted[sorted.length - 1].date : null,
  };
}

// Signed, adaptively-rounded number for the framing string. Small magnitudes keep
// two decimals (CRP 0.08); larger ones one (LDL 12.3), so the shift stays legible
// across the whole biomarker range.
function fmtDelta(n: number): string {
  const abs = Math.abs(n);
  const rounded = abs < 1 ? Number(n.toFixed(2)) : Number(n.toFixed(1));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded)}`;
}

// "8 weeks" for a clean multiple / long span, else "N days". Used for the "vs the
// … prior" phrasing.
export function spanLabel(days: number): string {
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

function judge(
  direction: OutcomeDirection,
  meanDelta: number | null
): Betterness {
  if (meanDelta == null) return "unknown";
  if (meanDelta === 0) return "unchanged";
  if (direction === "higher_better") return meanDelta > 0 ? "better" : "worse";
  if (direction === "lower_better") return meanDelta < 0 ? "better" : "worse";
  return "unknown"; // in_range / neutral — report the shift, no verdict
}

// Compare one outcome series across the two windows. Exported for focused unit
// tests; compareProtocol maps it over every series.
export function compareOutcome(
  series: OutcomeSeries,
  windows: {
    baseline: WindowRange;
    intervention: WindowRange;
    spanDays: number;
    startDate: string;
    baselineNearestFallback: boolean;
  }
): OutcomeComparison {
  const direction = series.direction ?? "neutral";
  const unit = series.unit ?? null;

  const inWindow = (d: string, w: WindowRange) => d >= w.start && d <= w.end;

  const interventionSamples = series.samples.filter((s) =>
    inWindow(s.date, windows.intervention)
  );
  let baselineSamples = series.samples.filter((s) =>
    inWindow(s.date, windows.baseline)
  );

  // Nearest-draw-before fallback for sparse labs: if the equal-length baseline
  // window caught nothing but there's an earlier reading, anchor the baseline on
  // the single most recent reading before the start.
  if (baselineSamples.length === 0 && windows.baselineNearestFallback) {
    const before = series.samples
      .filter((s) => s.date < windows.startDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (before.length) baselineSamples = [before[before.length - 1]];
  }

  const baseline = statsFor(baselineSamples);
  const intervention = statsFor(interventionSamples);

  const meanDelta =
    intervention.mean != null && baseline.mean != null
      ? intervention.mean - baseline.mean
      : null;
  const medianDelta =
    intervention.median != null && baseline.median != null
      ? intervention.median - baseline.median
      : null;

  const insufficient = baseline.n === 0 || intervention.n === 0;
  const betterness = judge(direction, meanDelta);

  let framing: string;
  if (insufficient || meanDelta == null) {
    framing = `Not enough readings to compare (baseline n=${baseline.n}, during n=${intervention.n}).`;
  } else if (meanDelta === 0) {
    framing = `${series.label} unchanged vs the ${spanLabel(
      windows.spanDays
    )} prior (n=${intervention.n} during vs ${baseline.n} before).`;
  } else {
    const unitStr = unit ? ` ${unit}` : "";
    framing = `${series.label} ${fmtDelta(meanDelta)}${unitStr} vs the ${spanLabel(
      windows.spanDays
    )} prior (n=${intervention.n} during vs ${baseline.n} before).`;
  }

  return {
    key: series.key,
    label: series.label,
    unit,
    direction,
    baseline,
    intervention,
    meanDelta,
    medianDelta,
    betterness,
    insufficient,
    framing,
  };
}

// Compare a protocol's whole outcome set. The intervention window is
// [startDate, endDate ?? today]; the baseline is the equal-length window ending
// the day before startDate. Both windows are inclusive; sample membership is a
// pure lexical date comparison (YYYY-MM-DD sorts chronologically).
export function compareProtocol(
  series: OutcomeSeries[],
  opts: CompareOptions
): ProtocolComparison {
  const startDate = opts.startDate;
  // Clamp a degenerate/blank end to the start so the span is at least one day.
  let end = opts.endDate ?? opts.today;
  if (end < startDate) end = startDate;

  const spanDays = (daysBetweenDateStr(startDate, end) ?? 0) + 1;
  const interventionWindow: WindowRange = { start: startDate, end };
  const baselineWindow: WindowRange = {
    start: shiftDateStr(startDate, -spanDays),
    end: shiftDateStr(startDate, -1),
  };
  const baselineNearestFallback = opts.baselineNearestFallback !== false;

  const outcomes = series.map((s) =>
    compareOutcome(s, {
      baseline: baselineWindow,
      intervention: interventionWindow,
      spanDays,
      startDate,
      baselineNearestFallback,
    })
  );

  return { interventionWindow, baselineWindow, spanDays, outcomes };
}
