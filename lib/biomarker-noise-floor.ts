// Measurement-noise floor for the biomarker trajectory engine (issue #563). Pure,
// no DB/network.
//
// The trajectory "approaching boundary" rule fits a robust (Theil–Sen) slope and
// extrapolates a future range crossing. That math is statistically sound but has
// no CLINICAL floor: a 1-unit SpO2 wiggle (98→97, inside a pulse-oximeter's ±2%
// error) fits a confident decline and projects "crosses 95 in ~1.5 years" — noise
// dressed up as signal. A false "your oxygen is declining" projection erodes trust
// in every real one.
//
// This module answers one question: what total change is even MEANINGFUL for this
// analyte — the smallest move a trajectory must clear before it's worth surfacing?
// The engine (lib/biomarker-trajectory) suppresses an approaching finding whose
// fitted change AND observed value range both sit at/under the floor.
//
// Sources, in preference order (issue #563):
//   1. A CURATED per-analyte floor for analytes whose device/assay error is known
//      and exceeds what raw recording resolution implies (SpO2's ±2 points). Small,
//      well-justified, each with a source.
//   2. RESOLUTION — an integer-recorded series can't express a sub-unit move, so a
//      1-point change is at the recording limit (i.e. noise): floor = 1 unit. Needs
//      no curated data and covers every integer-recorded bounded vital.
//   3. FALLBACK — a small fraction of the reference-range width, for a bounded
//      analyte with neither a curated floor nor integer recording.
// null = no floor could be derived (an unbounded, non-integer analyte); the engine
// then applies no noise gate, exactly as before this change.

// Curated absolute noise floors in canonical units, keyed by lowercased canonical
// name. Keep this list SMALL and each entry SOURCED — it only exists for analytes
// whose real measurement error is wider than their recording resolution suggests.
const CURATED_NOISE_FLOOR: Record<string, number> = {
  // Pulse-oximeter SpO2 accuracy (root-mean-square error, Arms) is ±2% across
  // FDA-cleared devices (FDA pulse-oximeter guidance; ISO 80601-2-61), so a move
  // of ≤2 points is within device error. SpO2 is also integer-recorded, which
  // alone would only give a floor of 1 — the curated value is what captures the
  // real ±2 band (the reported 98→97 false decline).
  "oxygen saturation": 2,
};

// The last-resort floor as a fraction of the reference-range width (source 3).
export const REFERENCE_WIDTH_NOISE_FRACTION = 0.05;

// The curated floor for an analyte, or null when none is curated. Case-insensitive
// on the canonical name.
export function curatedNoiseFloor(
  canonical: string | null | undefined
): number | null {
  if (!canonical) return null;
  return CURATED_NOISE_FLOOR[canonical.trim().toLowerCase()] ?? null;
}

// The measurement-noise floor (in the values' unit) for one analyte's series, or
// null when none can be derived. Curated > resolution > reference-width fraction.
export function noiseFloorForSeries(
  canonical: string | null | undefined,
  values: readonly number[],
  reference: { low: number | null; high: number | null } | null
): number | null {
  const curated = curatedNoiseFloor(canonical);
  if (curated != null) return curated;

  const finite = values.filter((v) => Number.isFinite(v));
  // Integer-recorded ⇒ the recording resolution is 1 unit; a 1-point total change
  // is at (not above) the resolution limit, so 1 is the floor.
  if (finite.length > 0 && finite.every((v) => Number.isInteger(v))) return 1;

  if (
    reference &&
    reference.low != null &&
    reference.high != null &&
    reference.high > reference.low
  ) {
    return (reference.high - reference.low) * REFERENCE_WIDTH_NOISE_FRACTION;
  }
  return null;
}
