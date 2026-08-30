// Pure normalization for the three manual body-sample fields on the combined "Log
// measurements" form (no DB, no React) — unit-tested in
// lib/__tests__/composition-input.test.ts. The SIBLING of lib/growth-input.ts and
// lib/waist-input.ts, not a member of either: "growth" is the life-stage-gated
// height/head-circumference pair the WHO/CDC card reads and "waist" is the tape,
// while these three are the metric_samples quantities #1851 found charted and
// imported but not enterable.
//
// Lean mass, bone mass and hydration ride ONE normalizer rather than three
// near-copies because they are one shape: a single optional number per field,
// landing in metric_samples under the SAME metric key the Health Connect and
// Withings writers use ('lean_mass_kg' / 'bone_mass_kg' / 'hydration_l'), so a
// DEXA figure typed at home reaches lib/protein.ts's band and the hydration chart
// identically to a synced one.
//
// PLAUSIBILITY IS THE INGEST ENVELOPE, not a second opinion: the same
// `inMetricBounds` bands lib/ingest-bounds.ts applies to a pushed reading, and the
// same `roundForMetric` storage precision, so a manual value and an imported one
// are accepted and stored on identical terms. Masses convert to canonical
// kilograms through `toKg` at this boundary; hydration is entered in litres, which
// is already its canonical unit.

import { inMetricBounds, roundForMetric } from "./ingest-bounds";
import { toKg } from "./units";
import type { WeightUnit } from "./settings";

export const LEAN_MASS_METRIC = "lean_mass_kg";
export const BONE_MASS_METRIC = "bone_mass_kg";
export const HYDRATION_METRIC = "hydration_l";

export interface CompositionInputRaw {
  leanMass: string | null;
  leanMassUnit: string | null; // 'kg' | 'lb'
  boneMass: string | null;
  boneMassUnit: string | null; // 'kg' | 'lb'
  hydration: string | null; // litres
}

// One canonical metric_samples sample to upsert.
export interface CompositionSample {
  metric:
    typeof LEAN_MASS_METRIC | typeof BONE_MASS_METRIC | typeof HYDRATION_METRIC;
  value: number;
}

export type CompositionInputResult =
  { samples: CompositionSample[] } | { error: string };

// A blank/whitespace field is "not measured" (skipped); a present-but-unparseable
// number is a hard error so the form can't show a false "saved".
function parseField(raw: string | null): number | null | "blank" {
  const t = (raw ?? "").trim();
  if (t === "") return "blank";
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function submittedMassUnit(unit: string | null): WeightUnit {
  return unit === "lb" ? "lb" : "kg";
}

export function normalizeCompositionInput(
  input: CompositionInputRaw
): CompositionInputResult {
  const samples: CompositionSample[] = [];

  const mass = (
    raw: string | null,
    unit: string | null,
    metric: typeof LEAN_MASS_METRIC | typeof BONE_MASS_METRIC,
    label: string
  ): string | null => {
    const v = parseField(raw);
    if (v === null) return `Enter a valid ${label}.`;
    if (v === "blank") return null;
    const kg = roundForMetric(metric, toKg(v, submittedMassUnit(unit)));
    if (!inMetricBounds(metric, kg)) return `That ${label} looks out of range.`;
    samples.push({ metric, value: kg });
    return null;
  };

  const leanError = mass(
    input.leanMass,
    input.leanMassUnit,
    LEAN_MASS_METRIC,
    "lean mass"
  );
  if (leanError) return { error: leanError };
  const boneError = mass(
    input.boneMass,
    input.boneMassUnit,
    BONE_MASS_METRIC,
    "bone mass"
  );
  if (boneError) return { error: boneError };

  const water = parseField(input.hydration);
  if (water === null) return { error: "Enter a valid water intake." };
  if (water !== "blank") {
    const litres = roundForMetric(HYDRATION_METRIC, water);
    if (!inMetricBounds(HYDRATION_METRIC, litres)) {
      return { error: "That water intake looks out of range." };
    }
    samples.push({ metric: HYDRATION_METRIC, value: litres });
  }

  if (samples.length === 0) {
    return { error: "Enter a lean mass, bone mass or water intake." };
  }
  return { samples };
}

// Client-side pre-check mirroring the action: the first error message, or null when
// the input would persist at least one sample. Lets the form surface an inline
// error instead of a silent no-op.
export function validateCompositionInput(
  input: CompositionInputRaw
): string | null {
  const res = normalizeCompositionInput(input);
  return "error" in res ? res.error : null;
}
