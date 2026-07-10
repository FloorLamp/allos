import type { DistanceUnit, WeightUnit } from "./settings";

// Canonical storage units are kilograms and kilometers.
export const LB_PER_KG = 2.2046226218;
export const MI_PER_KM = 0.62137119224;

export function kgTo(kg: number, unit: WeightUnit): number {
  return unit === "lb" ? kg * LB_PER_KG : kg;
}
export function toKg(value: number, unit: WeightUnit): number {
  return unit === "lb" ? value / LB_PER_KG : value;
}
export function kmTo(km: number, unit: DistanceUnit): number {
  return unit === "mi" ? km * MI_PER_KM : km;
}
export function toKm(value: number, unit: DistanceUnit): number {
  return unit === "mi" ? value / MI_PER_KM : value;
}

export function round(n: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Resolve a submitted display-unit weight back to canonical kg, treating a
// value that is materially unchanged from the stored canonical value as a true
// no-op. Edit forms pre-fill `round(kgTo(stored, unit), decimals)`; on save the
// action would re-store `toKg(submitted, unit)`, which for lb-preference users
// nudges the canonical kg by up to the rounding quantum on every round-trip —
// even when the user never touched the field. So if the submitted (display)
// number equals the rounded display of the stored kg, keep the stored kg
// exactly rather than re-deriving it from the rounded display (issue #194). A
// genuinely changed value still converts through toKg as before.
export function resolveWeightKg(
  submitted: number,
  storedKg: number | null | undefined,
  unit: WeightUnit,
  decimals = 1
): number {
  if (
    storedKg != null &&
    round(kgTo(storedKg, unit), decimals) === round(submitted, decimals)
  ) {
    return storedKg;
  }
  return toKg(submitted, unit);
}

// Sanitize a numeric text input so it can't hold a negative value: strips any
// minus signs while leaving an in-progress decimal ("1.", "0.5") untouched.
// Weights are never negative, so this enforces a floor of 0 on entry.
export function stripNegative(v: string): string {
  return v.replace(/-/g, "");
}

// Sanitize an integer count input (reps) where zero is as meaningless as a
// negative: a value that parses to 0 clears to empty, enforcing a floor of 1
// on anything actually entered.
export function stripNonPositive(v: string): string {
  const s = stripNegative(v);
  return s.trim() !== "" && Number(s) === 0 ? "" : s;
}

// Display number (converted + rounded), e.g. for chart values.
export function dispWeight(kg: number, unit: WeightUnit, decimals = 1): number {
  return round(kgTo(kg, unit), decimals);
}

// Formatted strings with the unit suffix.
export function fmtWeight(
  kg: number | null | undefined,
  unit: WeightUnit
): string {
  if (kg == null) return "—";
  return `${round(kgTo(kg, unit), 1)} ${unit}`;
}
export function fmtDistance(
  km: number | null | undefined,
  unit: DistanceUnit
): string {
  if (km == null) return "—";
  return `${round(kmTo(km, unit), 2)} ${unit}`;
}

// A speed given in km/h, rendered in the user's distance unit ("12.4 km/h").
export function fmtKmh(
  kmh: number | null | undefined,
  unit: DistanceUnit
): string {
  if (kmh == null) return "—";
  return `${round(kmTo(kmh, unit), 1)} ${unit}/h`;
}

// Average speed in the user's distance unit per hour, or null if not derivable.
export function avgSpeed(
  km: number | null | undefined,
  durationMin: number | null | undefined,
  unit: DistanceUnit
): number | null {
  if (km == null || !durationMin || durationMin <= 0) return null;
  return round(kmTo(km, unit) / (durationMin / 60), 1);
}

export function fmtSpeed(
  km: number | null | undefined,
  durationMin: number | null | undefined,
  unit: DistanceUnit
): string | null {
  const s = avgSpeed(km, durationMin, unit);
  return s == null ? null : `${s} ${unit}/h`;
}
