export type MeasurementEntryMetric =
  | "weight"
  | "body-fat"
  | "resting-hr"
  | "blood-pressure"
  | "spo2"
  | "temperature"
  | "hrv"
  | "height"
  | "head-circ"
  | "peak-flow"
  // Waist circumference (#2322) — ungated: a tape measurement is the entry surface
  // the whole ruling rests on, and it applies at every life stage.
  | "waist-circ"
  // The four #1851 closed: charted and imported, but with no way to type them in.
  // A counted breathing rate and a day's water are ungated like the tape above; lean
  // and bone mass are NOT, because they are body composition — the same class as body
  // fat %, off the same DEXA report, and gated with it since #4147.
  | "respiratory-rate"
  | "lean-mass"
  | "bone-mass"
  | "hydration";

export interface MeasurementEntryGates {
  // Manual body-composition entry: body fat %, lean mass, bone mass, as one class
  // (#4147). Composition for a growth-tracked profile arrives by document import.
  showCompositionEntry: boolean;
  showGrowth: boolean;
  showHeadCirc: boolean;
}

// Metric detail routes use the same life-stage gates as the combined measurement
// form. A direct URL must not turn a hidden field back into an entry surface.
export function isMeasurementEntryAllowed(
  metric: MeasurementEntryMetric,
  gates: MeasurementEntryGates
): boolean {
  if (metric === "body-fat" || metric === "lean-mass" || metric === "bone-mass")
    return gates.showCompositionEntry;
  if (metric === "hrv") return !gates.showGrowth;
  if (metric === "head-circ") return gates.showHeadCirc;
  return true;
}
