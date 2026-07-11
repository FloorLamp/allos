// Pure client-side validation for the body-metrics "Add entry" form. The
// addBodyMetric server action silently skips non-finite / out-of-range numbers
// (so bad input can't land as NaN), which on its own would leave the user with
// a false "saved" confirmation. This mirrors those bounds up front so the form
// can surface an inline error instead. Kept DB-free and pure so it's unit-tested
// in lib/__tests__.

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
// input is acceptable. Weight is required; body fat and resting HR are optional
// but, when provided, must be in range.
export function validateBodyMetricInput(
  input: BodyMetricRawInput
): string | null {
  const weightRaw = input.weight ?? "";
  const weight = Number(weightRaw);
  if (weightRaw.trim() === "" || !Number.isFinite(weight) || weight <= 0) {
    return "Enter a weight greater than 0.";
  }
  if (weight > MAX_PLAUSIBLE_WEIGHT) {
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
