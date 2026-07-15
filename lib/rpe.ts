// RPE (Rate of Perceived Exertion) on the RIR-anchored 5–10 half-point scale
// (issue #743). Pure and client-safe — no DB/network — so both the set-save write
// boundary and the client set-row selector share ONE definition of the scale.
//
// RPE is an OPTIONAL per-set effort rating that COMPOSES with the set's declared
// intent (target reps / to-failure) rather than replacing it. When the anchor set
// of a session carries one, lib/coaching/strength.ts reads it as a modifier on the
// double-progression verdict; absent RPE ⇒ the pre-RPE behavior unchanged.

export const RPE_MIN = 5;
export const RPE_MAX = 10;
export const RPE_STEP = 0.5;

// A sensible starting rating when the user first engages the (blank-by-default)
// selector — a solid working set, ~2 reps in reserve.
export const RPE_DEFAULT = 8;

// Canonicalize a submitted RPE at the WRITE boundary. The DB CHECK only bounds the
// value to 5–10 (and admits NULL); the half-point step discipline is enforced HERE:
//   - null / undefined / non-finite ⇒ null (no RPE logged)
//   - a value below 5 or above 10   ⇒ null (out of scale — REJECTED, not clamped,
//                                     so a stray number can't masquerade as effort)
//   - an in-range value             ⇒ snapped to the nearest half point
// So a valid rating always lands on {5, 5.5, …, 10} and the CHECK can never throw a
// raw constraint error at the writer.
export function canonicalRpe(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v < RPE_MIN || v > RPE_MAX) return null;
  return Math.round(v / RPE_STEP) * RPE_STEP;
}

// Step an RPE value by one half point within [5, 10], used by the set-row stepper.
// Stepping DOWN off the floor clears the rating back to blank (null) — logging RPE
// is never required, so the control can always be emptied again. Stepping UP from
// blank seeds the default working rating.
export function stepRpe(v: number | null, dir: 1 | -1): number | null {
  if (v == null) return dir === 1 ? RPE_DEFAULT : null;
  const next = v + dir * RPE_STEP;
  if (next < RPE_MIN) return null;
  if (next > RPE_MAX) return RPE_MAX;
  // Snap to the grid so a legacy off-step stored value settles onto it.
  return Math.round(next / RPE_STEP) * RPE_STEP;
}

// Format an RPE for display: "7", "9.5" — drop the trailing ".0".
export function fmtRpe(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// A compact "RPE" summary of a session's sets for a history row: the single value
// when uniform ("RPE 8"), the min–max span when it varied ("RPE 7–9"), or null
// when no set carried a rating. Sets without RPE are simply skipped.
export function rpeSummaryText(
  sets: readonly { rpe?: number | null }[]
): string | null {
  const vals = sets
    .map((s) => s.rpe)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length === 0) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return lo === hi ? `RPE ${fmtRpe(lo)}` : `RPE ${fmtRpe(lo)}–${fmtRpe(hi)}`;
}
