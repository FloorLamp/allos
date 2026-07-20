// Pure PEDIATRIC label-dosing lookup (issue #798). No DB/network, so it lives in the
// pure test tier (lib/__tests__/prn-dosing.test.ts). Given a curated ingredient entry
// (lib/prn-defaults) plus the child's AGE and latest RECORDED weight, reproduce the
// OTC label's weight-band chart — an informational lookup, NEVER a mg/kg computation.
//
// Design discipline (issue #798, kept apart from any dosing calculation):
//   • WEIGHT BANDS ONLY. bandForWeightLbs picks the label band for the weight; a
//     weight between two label bands lands conservatively on the LOWER (lower-dose)
//     band, and a weight below the smallest band is a refusal, never an extrapolation.
//   • HARD AGE GATES as refusals. Below the ingredient's minAgeMonths the result is
//     the label's own "ask a doctor" text, not a scaled dose.
//   • mg is canonical; mL only through a user-PICKED formulation/concentration.
//   • WEIGHT FRESHNESS. A weight older than an age-scaled threshold prompts to update
//     it BEFORE any band is suggested (kids grow; a stale band under-doses).
//   • The band amount is a SUGGESTION to confirm, carrying the label caveat — never
//     silently applied (that confirm is the liability line).

import type {
  PediatricBand,
  PrnDefaultEntry,
  PrnFormulation,
} from "./prn-defaults";
import type { WeightUnit } from "./settings";
import { daysBetweenDateStr } from "./date";

// The profile's pediatric-dosing context, threaded from the med page into the form so
// it can reproduce the OTC label's weight-band suggestion. ageMonths null ⇒ no
// birthdate/age on file (the form hides the pediatric block); weightKg is the latest
// RECORDED body weight (canonical kg) and weightDate its date (for the freshness gate).
export interface PediatricFormContext {
  ageMonths: number | null;
  weightKg: number | null;
  weightDate: string | null;
  // The acting login's display preference. The inline weight update writes through
  // the standard body-metric path, which converts this unit back to canonical kg.
  weightUnit: WeightUnit;
  today: string;
}

// Shared child/adult boundary for every medication-form pediatric surface and its
// selection-prefill engine. Keeping this here prevents the quick, full, and edit
// paths from drifting onto different age gates.
export const PEDIATRIC_MAX_AGE_MONTHS = 216; // 18 years

// Canonical body weight is stored in kilograms; OTC pediatric charts are in pounds.
const KG_PER_LB = 0.45359237;

export function kgToLbs(kg: number): number {
  return kg / KG_PER_LB;
}

// The label band for a weight (pounds): the HIGHEST band whose inclusive lower bound
// (minLbs) is <= the weight. A weight sitting between two label bands therefore lands
// on the LOWER band (the conservative, lower-dose choice, issue #798); a weight below
// the smallest band returns null (a refusal — see pediatricDoseSuggestion). Bands are
// assumed ascending by minLbs (the dataset stores them so); this doesn't rely on it.
export function bandForWeightLbs(
  bands: readonly PediatricBand[],
  weightLbs: number
): PediatricBand | null {
  let best: PediatricBand | null = null;
  for (const b of bands) {
    if (weightLbs >= b.minLbs && (best === null || b.minLbs > best.minLbs)) {
      best = b;
    }
  }
  return best;
}

// A human range label for a matched band ("24–35 lb", "72+ lb" for the top band),
// derived from the NEXT band's lower bound. Pure display helper.
export function bandRangeLabel(
  bands: readonly PediatricBand[],
  band: PediatricBand
): string {
  const sorted = [...bands].sort((a, b) => a.minLbs - b.minLbs);
  const i = sorted.findIndex((b) => b.minLbs === band.minLbs);
  const next = i >= 0 ? sorted[i + 1] : undefined;
  return next ? `${band.minLbs}–${next.minLbs - 1} lb` : `${band.minLbs}+ lb`;
}

// Whether the ingredient's hard age gate refuses at this age — the label's own
// "under N months, ask a doctor". True ⇒ show ageGateText instead of any dose.
export function isPediatricAgeGated(
  ped: PrnPediatricLike,
  ageMonths: number
): boolean {
  return ageMonths < ped.minAgeMonths;
}
type PrnPediatricLike = { minAgeMonths: number };

// Age-scaled weight-freshness threshold (days). Younger children grow faster, so a
// weight goes stale sooner. Coarse, deliberately conservative bands.
export function weightStalenessDays(ageMonths: number): number {
  if (ageMonths < 12) return 60;
  if (ageMonths < 60) return 120;
  return 180;
}

// Whether the latest recorded weight is too old to band from at this age. A missing
// date reads as stale (we can't trust an undated weight for a growing child).
export function isWeightStale(
  ageMonths: number,
  recordedDate: string | null,
  today: string
): boolean {
  if (!recordedDate) return true;
  const age = daysBetweenDateStr(recordedDate, today);
  if (age == null) return true;
  return age > weightStalenessDays(ageMonths);
}

// mL for a band's mg through a picked formulation — ONLY when a concentration is
// chosen (issue #798: a volume depends on the product). Rounded to a readable 0.05 mL.
// Null when no formulation is picked or its concentration is unusable.
export function mlForBand(
  formulation: PrnFormulation | null | undefined,
  mg: number
): number | null {
  if (!formulation || !(formulation.mgPerMl > 0)) return null;
  const ml = mg / formulation.mgPerMl;
  return Math.round(ml * 20) / 20;
}

// Resolve the stable picker value to the curated formulation that should be stored
// with the medication. The database keeps the human-readable label in `product` so
// the concentration remains useful outside this form (lists, detail, print/share).
export function formulationForSlug(
  formulations: readonly PrnFormulation[],
  slug: string | null | undefined
): PrnFormulation | null {
  if (!slug) return null;
  return formulations.find((formulation) => formulation.slug === slug) ?? null;
}

// Restore the picker from an already-saved product label. Also accept a stored slug
// defensively so an early/internal caller cannot strand the selection.
export function formulationSlugForProduct(
  formulations: readonly PrnFormulation[],
  product: string | null | undefined
): string {
  const normalized = product?.trim().toLocaleLowerCase();
  if (!normalized) return "";
  return (
    formulations.find(
      (formulation) =>
        formulation.slug.toLocaleLowerCase() === normalized ||
        formulation.label.trim().toLocaleLowerCase() === normalized
    )?.slug ?? ""
  );
}

// The label caveat that rides EVERY pediatric suggestion — the confirm-line reminder
// that this is a label lookup, not a prescription.
export const PEDIATRIC_DOSE_CAVEAT =
  "From the product label — confirm against your package before giving.";

// The typed result of a pediatric label lookup. Every non-"dose" kind is a REFUSAL or
// a prompt (never a computed dose), matching issue #798's "gates are refusals".
export type PediatricDoseResult =
  | { kind: "no-pediatric" } // ingredient has no OTC pediatric weight-band table
  | { kind: "ask-doctor"; reason: string } // the label's hard age gate
  | { kind: "need-weight" } // no recorded weight to band from
  | { kind: "stale-weight"; recordedDate: string | null; thresholdDays: number }
  | {
      kind: "below-weight-band";
      weightLbs: number;
      minimumLbs: number;
      recordedDate: string | null;
    }
  | {
      kind: "dose";
      mg: number;
      band: PediatricBand;
      bandLabel: string;
      weightLbs: number;
      recordedDate: string | null;
      ml: number | null;
      formulationLabel: string | null;
      caveat: string;
    };

// Reproduce the OTC label's pediatric suggestion for one child from the curated
// entry. Order of decisions is deliberate: no-table → age gate → no weight →
// stale weight → below-smallest-band refusal → the band dose. `formulationSlug` is the
// user's picked product concentration (mL only surfaces when it's set and known).
export function pediatricDoseSuggestion(input: {
  entry: PrnDefaultEntry;
  ageMonths: number;
  weightKg: number | null;
  weightDate: string | null;
  today: string;
  formulationSlug?: string | null;
}): PediatricDoseResult {
  const ped = input.entry.pediatric;
  if (!ped) return { kind: "no-pediatric" };

  if (isPediatricAgeGated(ped, input.ageMonths)) {
    return { kind: "ask-doctor", reason: ped.ageGateText };
  }
  if (input.weightKg == null || !(input.weightKg > 0)) {
    return { kind: "need-weight" };
  }
  if (isWeightStale(input.ageMonths, input.weightDate, input.today)) {
    return {
      kind: "stale-weight",
      recordedDate: input.weightDate,
      thresholdDays: weightStalenessDays(input.ageMonths),
    };
  }

  const weightLbs = kgToLbs(input.weightKg);
  const band = bandForWeightLbs(ped.bands, weightLbs);
  if (!band) {
    // Below the smallest label band is distinct from the medication's AGE gate. The
    // old path reused ageGateText here (e.g. "under 3 months") even for an older,
    // lighter child, making it appear that the form had ignored the profile's age.
    // Keep refusing to extrapolate, but report the actual unmatched weight boundary.
    const minimumLbs = Math.min(
      ...ped.bands.map((candidate) => candidate.minLbs)
    );
    return {
      kind: "below-weight-band",
      weightLbs: Math.round(weightLbs * 10) / 10,
      minimumLbs,
      recordedDate: input.weightDate,
    };
  }

  const formulation = formulationForSlug(
    ped.formulations,
    input.formulationSlug
  );
  return {
    kind: "dose",
    mg: band.mg,
    band,
    bandLabel: bandRangeLabel(ped.bands, band),
    weightLbs: Math.round(weightLbs * 10) / 10,
    recordedDate: input.weightDate,
    ml: mlForBand(formulation, band.mg),
    formulationLabel: formulation?.label ?? null,
    caveat: PEDIATRIC_DOSE_CAVEAT,
  };
}
