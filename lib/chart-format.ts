// Shared chart-value display rounding (issue #403). A biomarker chart point is a
// bare unit conversion (e.g. 103 mg/dL → 5.716552154288337 mmol/L), fine as the
// domain input recharts maps to a pixel, but wrong to render verbatim: the axis
// tick, the tile headline, and the readings table all show a ROUNDED number, so a
// tooltip printing the raw float ("5.716552154288337 mmol/L" against an axis that
// says "5.72") reads as a bug. This is the ONE rounding every chart tooltip (and
// the biomarker axis tick) routes through, so every surface reads the same number
// — "one question, one computation". It rounds for DISPLAY only; callers keep the
// full-precision value as the recharts domain input.
//
// `decimals` is the per-series display precision when the caller knows it (the
// TrendMiniCard sparkline passes the same `decimals` its headline uses, so the two
// agree exactly); omitted, it caps at 2 decimals, mirroring the biomarker axis
// tick's historical `Math.round(v * 100) / 100`. Trailing zeros are dropped by the
// numeric round (5.70 → 5.7), matching the tick.
export function roundChartValue(value: number, decimals?: number): number {
  if (!Number.isFinite(value)) return value;
  const d = decimals == null ? 2 : Math.max(0, decimals);
  const f = 10 ** d;
  return Math.round(value * f) / f;
}

// The same rounding, GROUPED (#1541). A count metric — steps, calories — runs to
// four and five digits, where a bare `12000` axis tick is measurably harder to read
// than `12,000`. Opt-in per chart (see `groupYTicks` on LineChartCard) and used for
// BOTH the axis tick and the tooltip, so the two never disagree about a number.
// Locale is PINNED to en-US, never the ambient one: an implicit locale renders
// differently on the server than in the browser (see lib/__tests__/date-locale-guard).
export function groupChartValue(value: number, decimals?: number): string {
  const n = roundChartValue(value, decimals);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}
