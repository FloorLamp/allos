// ONE way to write a clinical band down (#221/#2315).
//
// A reference or optimal band is `[low, high]` where either bound may be absent,
// and it is READ as text on three surfaces: the metric detail card
// (MetricJudgmentCard), the biomarker row's judgment cell, and the biomarker
// detail page's range cards. Each of those had — or was about to grow — its own
// `≥`/`≤`/en-dash spelling, so the same band could print three ways. This module
// is the spelling, once.
//
// PURE: no DB, no React, no unit conversion. Callers hand in numbers that are
// already in the unit they want shown, plus the suffix (leading space included)
// they want appended.

// The digits. Two jobs, and they pull in opposite directions:
//
//   • kill floating-point noise, so a padded/derived bound never renders
//     `0.30000000000000004`;
//   • never collapse a band whose meaning lives in its third decimal. Urine
//     Specific Gravity is curated 1.001–1.035 — round that to two places and the
//     row prints "1–1.04", which is both wrong and unfalsifiable on sight.
//
// Four places satisfies both: it is far past any curated precision in the
// canonical vocabulary, and far short of where IEEE-754 residue shows up.
const BAND_DECIMALS = 4;

export function bandNumber(n: number): string {
  const f = 10 ** BAND_DECIMALS;
  return String(Math.round(n * f) / f);
}

/**
 * A band as one short string, or null when the band states no bound at all.
 *
 *   • two-sided → `70–85` (en dash, not a hyphen — a hyphen reads as a minus)
 *   • high only → `≤ 60`
 *   • low only  → `≥ 2`
 *   • a POINT band (low === high) → `0`, one value rather than "0–0". A curated
 *     low === high is a single target (the "ideally undetectable" toxins pinned
 *     at 0), never a zero-width interval.
 *
 * `unit` is appended verbatim to the last number, so a caller that wants a space
 * passes one (`" mg/dL"`). Callers that render the unit elsewhere pass nothing.
 */
export function formatBand(
  low: number | null | undefined,
  high: number | null | undefined,
  unit = ""
): string | null {
  if (low != null && high != null) {
    return low === high
      ? `${bandNumber(low)}${unit}`
      : `${bandNumber(low)}–${bandNumber(high)}${unit}`;
  }
  if (low != null) return `≥ ${bandNumber(low)}${unit}`;
  if (high != null) return `≤ ${bandNumber(high)}${unit}`;
  return null;
}
