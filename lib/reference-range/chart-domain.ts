// ---------------------------------------------------------------------------
// Biomarker axis-domain policy (issue #311). "Given a biomarker value/series plus
// its reference and optimal band bounds, what numeric [lo, hi] should the axis
// span?" was computed twice, inline, in two client charts (BiomarkerScale's dot
// scale and BiomarkerChartInner's recharts Y domain) — with drifted padding
// constants (12% vs 8%). This is the ONE source of truth; both components are now
// pixel-mappers over its result. Pure math, so it's client-safe.
// ---------------------------------------------------------------------------

// The reference/optimal band bounds an axis must contain (any may be absent).
export interface AxisBounds {
  refLow?: number | null;
  refHigh?: number | null;
  optimalLow?: number | null;
  optimalHigh?: number | null;
}

export interface AxisDomainOpts {
  // Fraction of the span added as breathing room on each side (default 8%).
  padFraction?: number;
  // For wide spans, snap the domain outward to whole numbers so recharts picks
  // clean integer ticks; small-span analytes (HbA1c) keep their decimals.
  snapWideToIntegers?: boolean;
}

// Default breathing room: the time-series chart's historical 8%.
export const DEFAULT_AXIS_PAD_FRACTION = 0.08;
// The single-value dot scale opts into a touch more room (its lone marker should
// never sit flush against an edge) — now an explicit option, not a magic number.
export const SCALE_AXIS_PAD_FRACTION = 0.12;
// A span at or above this many units counts as "wide" for integer snapping.
export const WIDE_SPAN_THRESHOLD = 3;

// Compute the axis domain that comfortably contains every real mark (the
// value(s) plus any band bounds), with padding so nothing sits flush against an
// edge. Edge cases, unified across both charts:
//   - no finite marks at all               → a safe [0, 1] window
//   - flat series / single point (lo===hi) → open a ±1 window so the mark shows
//   - every real mark non-negative         → clamp the floor to 0 (biomarker
//                                             concentrations can't go below 0; the
//                                             padding/expansion must not pull the
//                                             axis under it). The decision uses the
//                                             PRE-expansion minimum, so a flat
//                                             series at 0 still clamps (this fixes
//                                             the trend chart, which previously
//                                             tested the post-expansion min).
//   - snapWideToIntegers + wide span       → floor/ceil the padded bounds to ints.
// `wide` reports whether integer snapping was applied (the caller uses it to set
// recharts `allowDecimals`).
export function biomarkerAxisDomain(
  values: Array<number | null | undefined>,
  bounds: AxisBounds,
  opts: AxisDomainOpts = {}
): { lo: number; hi: number; wide: boolean } {
  const {
    padFraction = DEFAULT_AXIS_PAD_FRACTION,
    snapWideToIntegers = false,
  } = opts;

  const marks: number[] = [];
  for (const v of values) if (v != null && Number.isFinite(v)) marks.push(v);
  for (const b of [
    bounds.refLow,
    bounds.refHigh,
    bounds.optimalLow,
    bounds.optimalHigh,
  ])
    if (b != null && Number.isFinite(b)) marks.push(b);

  if (marks.length === 0) return { lo: 0, hi: 1, wide: false };

  const minMark = Math.min(...marks);
  let min = minMark;
  let max = Math.max(...marks);
  if (min === max) {
    // Flat series / single point — open a small symmetric window so it shows.
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const pad = span * padFraction;
  const wide = snapWideToIntegers && span >= WIDE_SPAN_THRESHOLD;
  let lo = wide ? Math.floor(min - pad) : min - pad;
  const hi = wide ? Math.ceil(max + pad) : max + pad;
  // Every real mark non-negative → don't let padding pull the axis below 0.
  if (minMark >= 0) lo = Math.max(0, lo);
  return { lo, hi, wide };
}

// Approximate, human-friendly age for a span of days ("8 months", "1.4 years").
export function humanizeAge(days: number): string {
  if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} month${months === 1 ? "" : "s"}`;
  const years = days / 365.25;
  return `${years.toFixed(years < 10 ? 1 : 0)} years`;
}
