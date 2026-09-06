// RPE (Rate of Perceived Exertion) on the RIR-anchored 5–10 half-point scale
// (issue #743). Pure and client-safe — no DB/network — so both the set-save write
// boundary and the client set-row selector share ONE definition of the scale.
//
// RPE is an OPTIONAL per-set effort rating that COMPOSES with the set's declared
// intent (target reps / to-failure) rather than replacing it. When the anchor set
// of a session carries one, lib/coaching/strength.ts reads it as a modifier on the
// double-progression verdict; absent RPE ⇒ the pre-RPE behavior unchanged.
//
// LOGGING RPE IS OPTED INTO (#3335). The set grid used to carry the column for
// everyone; it now carries it only for a profile that asked for it. The opt-in is
// STRUCTURAL rather than a flag each read path remembers to check, in the shape
// #3323 used for reduction caps: there is nothing scale-shaped to render unless
// the profile's row exists.
//
//   • `RpeTracking` is BRANDED, so no ordinary expression produces one — an object
//     literal of the same fields does not typecheck as one.
//   • It is minted in exactly ONE place, `lib/rpe-tracking.ts`, and only on the
//     branch where the profile's opt-in row was found.
//   • `stepRpe` — the only way to compute the next value of the control — REQUIRES
//     one. A surface holding no tracking cannot offer the control, because it
//     cannot answer what a tap would do.
//
// Do not add a second minter, and do not add a helper that manufactures a tracking
// from a default: either would make the opt-in cosmetic again.
//
// `canonicalRpe` deliberately takes NO tracking. It is the write boundary, and a
// profile that never opted in (or opted back out) still edits sessions whose sets
// carry a stored rating — the rating rides back through the save untouched rather
// than being erased by a column that is not on screen. Opting out hides the
// column; it is not a delete.

const RPE_MIN = 5;
const RPE_MAX = 10;
const RPE_STEP = 0.5;

// A sensible starting rating when the user first engages the (blank-by-default)
// selector — a solid working set, ~2 reps in reserve.
const RPE_SEED = 8;

declare const RPE_TRACKING: unique symbol;

/**
 * A profile's opted-into RPE scale — what the per-set control steps over.
 * Minted only by `lib/rpe-tracking.ts`, and only from an existing opt-in row.
 */
export type RpeTracking = {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The rating a blank control seeds to on its first step up. */
  readonly seed: number;
  readonly [RPE_TRACKING]: true;
};

/**
 * THE minter, exported for `lib/rpe-tracking.ts` alone. It is not the opt-in
 * check — the caller has already found the row; this only names the scale.
 */
export function mintRpeTracking(): RpeTracking {
  return {
    min: RPE_MIN,
    max: RPE_MAX,
    step: RPE_STEP,
    seed: RPE_SEED,
    // eslint-disable-next-line no-restricted-syntax -- RpeTracking minter: this is the one construction site the brand is worth anything for
  } as RpeTracking;
}

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

// Step an RPE value by one half point within the tracked scale, used by the set-row
// stepper. Stepping DOWN off the floor clears the rating back to blank (null) —
// logging RPE is never required, so the control can always be emptied again.
// Stepping UP from blank seeds the default working rating.
//
// The tracking argument is the opt-in seam, not decoration: a surface that holds no
// tracking cannot call this, so it cannot render a control whose taps mean nothing.
export function stepRpe(
  tracking: RpeTracking,
  v: number | null,
  dir: 1 | -1
): number | null {
  if (v == null) return dir === 1 ? tracking.seed : null;
  const next = v + dir * tracking.step;
  if (next < tracking.min) return null;
  if (next > tracking.max) return tracking.max;
  // Snap to the grid so a legacy off-step stored value settles onto it.
  return Math.round(next / tracking.step) * tracking.step;
}

// Format an RPE for display: "7", "9.5" — drop the trailing ".0".
//
// Formatting takes no tracking on purpose: a rating already logged stays legible in
// history, recaps and coaching verdicts for a profile that has opted back out.
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
