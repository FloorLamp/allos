// Freeze-instant selection for the e2e suite (issues #990 / #1048 / #1464).
//
// `playwright.config.ts` freezes `ALLOS_TEST_NOW` at the run's real start so the seed
// fixtures and the app share ONE notion of "now". The residual that design accepted is
// the midnight CROSS: rows the suite writes at runtime keep real wall-time (SQL
// `datetime('now')` defaults), so a run that begins shortly before midnight spends the
// rest of itself writing rows dated TOMORROW while the frozen `today()` still says
// YESTERDAY — and every date-keyed assertion becomes a coin flip.
//
// The fix has to be chosen carefully, because the obvious one is backwards. You cannot
// stop real time from crossing midnight by picking a different freeze instant, so the
// only question is which side of the boundary the frozen date should sit on:
//
//   * Nudging the instant BACK (e.g. 23:57 → 22:57) keeps the frozen date on YESTERDAY
//     — the same side the run is leaving. Every row written after real midnight still
//     mismatches. It makes the gap wider, not narrower.
//   * Nudging it FORWARD across the boundary puts the frozen date on TOMORROW — the
//     side the run spends nearly all of its time on. The seed (which runs first, and
//     dates its fixtures from this same frozen clock) builds tomorrow-relative data,
//     and every runtime row written after real midnight then agrees with it.
//
// So we nudge FORWARD, and only inside the hazard window. Everywhere else the instant
// is untouched, which keeps the #1048 property that |real − frozen| stays within the
// suite's own duration.
//
// Pure and dependency-free so it can be unit-tested (lib/__tests__/e2e-freeze-instant
// .test.ts) — playwright.config.ts just calls it.

// How close to midnight counts as hazardous. The suite's own duration is ~25 min; 30
// gives it a margin without widening the window into ordinary evening runs.
export const FREEZE_HAZARD_MINUTES = 30;

// Where inside the next day the nudged instant lands. Far enough past midnight that a
// slow seed + boot cannot drift back across it, small enough to stay "about now".
export const FREEZE_NUDGE_TARGET_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

// Minutes remaining until the next UTC midnight. `today()` is per-profile in the app,
// but every e2e profile runs on the instance-default timezone the seed installs, and
// the suite's own reference frame is UTC — so UTC is the boundary that matters here.
export function minutesToUtcMidnight(at: Date): number {
  const midnight = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() + 1
  );
  return (midnight - at.getTime()) / MS_PER_MINUTE;
}

// True when freezing at `at` would leave the run straddling midnight.
export function isNearUtcMidnight(
  at: Date,
  hazardMinutes: number = FREEZE_HAZARD_MINUTES
): boolean {
  const remaining = minutesToUtcMidnight(at);
  return remaining > 0 && remaining <= hazardMinutes;
}

// The instant the suite should actually freeze at. Outside the hazard window this is
// `at` unchanged; inside it, the first minutes of the NEXT UTC day.
export function resolveFreezeInstant(
  at: Date,
  hazardMinutes: number = FREEZE_HAZARD_MINUTES
): Date {
  if (!isNearUtcMidnight(at, hazardMinutes)) return at;
  const midnight = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() + 1
  );
  return new Date(midnight + FREEZE_NUDGE_TARGET_MINUTES * MS_PER_MINUTE);
}
