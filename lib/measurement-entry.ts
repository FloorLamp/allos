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
  | "waist-circ";

export interface MeasurementEntryGates {
  showBodyFat: boolean;
  showGrowth: boolean;
  showHeadCirc: boolean;
}

// Metric detail routes use the same life-stage gates as the combined measurement
// form. A direct URL must not turn a hidden field back into an entry surface.
export function isMeasurementEntryAllowed(
  metric: MeasurementEntryMetric,
  gates: MeasurementEntryGates
): boolean {
  if (metric === "body-fat") return gates.showBodyFat;
  if (metric === "hrv") return !gates.showGrowth;
  if (metric === "head-circ") return gates.showHeadCirc;
  return true;
}
