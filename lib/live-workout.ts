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

// ── One live session is one row (#3441) ──────────────────────────────────────
//
// Starting a live workout POSTs its create-at-start row (#2870 step 3) while the
// editor opens rowless. Until that POST answers the session HAS a row and nobody
// knows its id — so a rowless auto-save dispatched in that window builds its
// FormData with a null id and INSERTS A SECOND ROW. Measured: hold the start POST
// and pick an exercise inside the window and the profile ends with two live
// drafts, the tab standing on one of them and the user's sets in the other.
//
// THE DECISION LIVES HERE, not inline in the hook, because two of its three terms
// are EXEMPTIONS — and an exemption is exactly the kind of clause that is wrong in
// the direction nothing observes. A browser test can only reach the combinations a
// user can drive, and the one that matters most (a close-path flush arriving while
// the create is still in flight) is reachable only through a recap Finish taken
// inside a slow round trip. Stated as a predicate, all four corners are checkable
// in one place, in both directions — always taken AND never taken.
export function shouldDeferRowlessSave({
  createPending,
  hasRow,
  closePath,
}: {
  // The create-at-start POST has gone out and not answered.
  createPending: boolean;
  // This form already owns a row (an edit, an adoption, or its own earlier create).
  hasRow: boolean;
  // A CLOSE-path flush (flushBeforeClose / the unmount flush), as opposed to the
  // debounced mid-session save.
  closePath: boolean;
}): boolean {
  // Nothing to wait for, or nothing to collide with: the id is already known.
  if (!createPending || hasRow) return false;
  // A CLOSE abandons the session, and the provider invalidates the still-in-flight
  // create in the same breath, so its answer can never be adopted. Waiting for it
  // would strand the last edit behind a request nobody is listening to any more —
  // and the offline capture (#1596) is reachable ONLY from a close-path persist, so
  // deferring one is how a dead-connection session stops being captured at all.
  return !closePath;
}
