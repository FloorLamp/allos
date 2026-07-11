// Estimated one-rep-max (Epley, capped). The strength LEVEL/standard logic that
// used to live here — the flat bodyweight-ratio tables (STANDARDS), levelFor,
// standardFor, the reference-table columns, and displayedStandards — was RETIRED
// in favor of the single bodyweight-band model in lib/strength-standards.ts (issue
// #152), so every surface answers "what level is this lift" from ONE computation
// ("one question, one computation"). Only the 1RM estimation stays here; it's
// independent of levels and consumed widely (queries, coaching, analyze).

// Reps past which Epley's linear rep bonus is no longer trustworthy. Epley
// (weight * (1 + reps/30)) is fit to the low-rep strength range and overestimates
// sharply for high-rep/endurance sets — a 20-rep set is nowhere near 1.67× its
// weight in true 1RM. We CAP the rep contribution at this many reps: any set with
// more reps is scored as if it were exactly this many. Chosen at 12 because ~1–12
// reps is the range single-formula estimators are reasonable over; blending in
// Brzycki was considered but it has its own high-rep blow-up (undefined at 37
// reps), whereas a hard cap is simple, bounded, and leaves the accurate 1–12
// range untouched.
export const E1RM_REP_CAP = 12;

// Epley estimated one-rep max with a high-rep cap (see E1RM_REP_CAP). A single
// rep returns the weight itself; more reps at the same weight estimate a higher
// 1RM up to the cap, past which the estimate no longer climbs. Non-positive reps
// fall back to the weight (no rep bonus) so callers never get a value below the
// lifted weight.
export function estimate1RM(weightKg: number, reps: number): number {
  if (reps <= 0) return weightKg;
  return weightKg * (1 + Math.min(reps, E1RM_REP_CAP) / 30);
}
