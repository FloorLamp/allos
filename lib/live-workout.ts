// Pure model for live workout mode (issue #340): the in-gym presentation of the
// activity editor with a set check-off flow and a rest timer. No React, no state,
// no side effects — everything here is a plain value or a pure derivation, so it
// is unit-testable in isolation (lib/__tests__/live-workout.test.ts) and shared by
// the live-mode components under components/activity-form.
//
// One-question-one-computation: the rest-timer default reuses the SAME heavy-lift
// classification the next-set suggestion uses (weightIncrementKg / isIsolation from
// lib/coaching), so "how hard is this lift" is decided in exactly one place.

import { isIsolation, weightIncrementKg } from "./coaching";

// One-tap rest presets (seconds) offered as chips in the live-mode timer.
export const REST_PRESETS_SEC = [60, 90, 120, 180] as const;

// The bounds an adjustable rest countdown can be nudged to (the ± buttons clamp
// here); 10 minutes is a generous ceiling for a between-set rest.
export const REST_MIN_SEC = 0;
export const REST_MAX_SEC = 600;

// How much each ± nudge moves the rest target.
export const REST_STEP_SEC = 15;

// Suggested default rest for an exercise, reusing the heavy-lift classification
// the next-set suggestion already uses (weightIncrementKg's 5 kg = big compound,
// isIsolation = accessory) so the two never disagree about what "heavy" means:
//   - isolation / accessory (curls, raises, …)      → 90 s
//   - big lower-body compound (squat/deadlift/…)     → 180 s
//   - everything else (upper compounds, presses)     → 120 s
// A non-strength or unknown name lands on the 120 s middle default, which is
// harmless — live mode is a strength-centric surface and the value is editable.
export function suggestedRestSec(exercise: string): number {
  if (isIsolation(exercise)) return 90;
  if (weightIncrementKg(exercise) === 5) return 180;
  return 120;
}

// Clamp a nudged/typed rest value into the allowed range (non-finite → floor).
export function clampRestSec(sec: number): number {
  if (!Number.isFinite(sec)) return REST_MIN_SEC;
  return Math.max(REST_MIN_SEC, Math.min(REST_MAX_SEC, Math.round(sec)));
}

// The exercise the rest-timer preset should track: the LAST non-empty name (the
// part currently being worked), else "" when nothing is named yet. Fed the parts'
// names so the pure decision stays testable without the form's PartEntry shape.
export function leadExerciseName(names: string[]): string {
  for (let i = names.length - 1; i >= 0; i--) {
    const n = names[i]?.trim();
    if (n) return n;
  }
  return "";
}
