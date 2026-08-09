// Pure client-side validation for the body-metrics "Add entry" form. The
// addBodyMetric server action silently skips non-finite / out-of-range numbers
// (so bad input can't land as NaN), which on its own would leave the user with
// a false "saved" confirmation. This mirrors those bounds up front so the form
// can surface an inline error instead. Kept DB-free and pure so it's unit-tested
// in lib/__tests__.
//
// It also owns the form's SAVE CONFIRMATION when the sitting's stated time did not
// survive the acceptance gate (#2311) — same reason, same tier: what the user is
// told about a write is a decision, and a decision belongs somewhere it can be
// tested rather than inside a JSX handler.

import type { StatedTimeRefusal } from "./stated-time";

export interface BodyMetricRawInput {
  weight: string | null;
  bodyFatPct: string | null;
  restingHr: string | null;
}

// Upper bound on a plausible human body weight, as the RAW number the user typed —
// which is in their display unit (kg OR lb), so the ceiling is chosen to be
// physically impossible in EITHER: the heaviest person on record was ~635 kg
// (~1400 lb), so 2000 rejects a gross entry error (an extra digit, or a value typed
// in grams) while never rejecting a real kg or lb weigh-in. Catching it at entry
// protects every downstream trend/goal from a wild outlier (issue #45, domain 5).
export const MAX_PLAUSIBLE_WEIGHT = 2000;

// Returns a human-readable error for the first invalid field, or null if the
// input is acceptable. The combined measurements form requires weight for its
// body-composition row by default. A metric detail page can set `requireWeight:
// false` when it deliberately exposes only body fat or resting HR — both columns
// are nullable in body_metrics and are valid observations in their own right.
export function validateBodyMetricInput(
  input: BodyMetricRawInput,
  options: { requireWeight?: boolean } = {}
): string | null {
  const requireWeight = options.requireWeight ?? true;
  const weightRaw = input.weight ?? "";
  const hasWeight = weightRaw.trim() !== "";
  const weight = Number(weightRaw);
  if (
    (requireWeight && !hasWeight) ||
    (hasWeight && (!Number.isFinite(weight) || weight <= 0))
  ) {
    return "Enter a weight greater than 0.";
  }
  if (hasWeight && weight > MAX_PLAUSIBLE_WEIGHT) {
    return "That weight looks too high to be real — please check the value.";
  }

  const bodyFatRaw = input.bodyFatPct ?? "";
  if (bodyFatRaw.trim() !== "") {
    const bodyFat = Number(bodyFatRaw);
    if (!Number.isFinite(bodyFat) || bodyFat < 0 || bodyFat > 100) {
      return "Body fat must be between 0 and 100%.";
    }
  }

  const restingHrRaw = input.restingHr ?? "";
  if (restingHrRaw.trim() !== "") {
    const restingHr = Number(restingHrRaw);
    if (!Number.isFinite(restingHr) || restingHr <= 0 || restingHr > 400) {
      return "Resting HR must be between 1 and 400 bpm.";
    }
  }

  return null;
}

// THIS SURFACE'S WORDS for a refused stated time (#2311, #2296's ruling applied to
// body metrics). One clause per rule, because the three are different things to
// hear — and deliberately NOT `STATED_TIME_REFUSAL_NOTE`, which says "your device's
// clock is ahead". That clause belongs to a surface that timestamped the statement
// ITSELF; here the time is a field the user can see, typed or filled by the
// control's one-tap "Now", so diagnosing their clock would be diagnosing the wrong
// machine. What is shared is the REASON CODE, which is the whole point of the
// verdict.
const MEASUREMENT_TIME_NOTE: Record<StatedTimeRefusal, string> = {
  future: "that time hasn't happened yet",
  "other-day": "it isn't on that day",
  malformed: "it couldn't be read",
};

// The confirmation the measurements form raises after a successful save.
//
// A refusal is a NOTICE, not a failure: the reading LANDED, so this stays the
// ordinary success toast and only amends the sentence it was already going to say.
// `saved` is the surface's own subject ("Measurements saved", "Weight saved") —
// what was kept belongs to the surface, the reason belongs to the gate.
//
// Nothing is persisted to chase the user afterwards, deliberately (#2296's ruling,
// re-affirmed by #2311): `occurred_at` is descriptive, the row is on the right day,
// and its Time is one tap away in the same form.
export function measurementsSavedText(
  saved: string,
  statedTimeRefused?: StatedTimeRefusal
): string {
  return statedTimeRefused
    ? `${saved} without the time — ${MEASUREMENT_TIME_NOTE[statedTimeRefused]}.`
    : saved;
}
