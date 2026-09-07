// Pure PEDIATRIC label-dosing lookup (issue #798). No DB/network, so it lives in the
// pure test tier (lib/__tests__/prn-dosing.test.ts). Given a curated ingredient entry
// (lib/prn-defaults) plus the child's AGE and latest RECORDED weight, reproduce the
// OTC label's weight-band chart — an informational lookup, NEVER a mg/kg computation.
//
// Design discipline (issue #798, kept apart from any dosing calculation):
//   • WEIGHT BANDS ONLY. bandForWeightLbs picks the label band for the weight; a
//     weight between two label bands lands conservatively on the LOWER (lower-dose)
//     band, and a weight below the smallest band is a refusal, never an extrapolation.
//   • HARD AGE GATES as refusals, at BOTH ends. Below the ingredient's minAgeMonths
//     the result is the label's own "ask a doctor" text, not a scaled dose; at or
//     above its maxAgeMonths the chart has stopped covering the subject and refuses
//     too (#5539) — the weight bands have no top, so without that the chart's top row
//     answers for an adolescent the children's label never spoke about.
//   • mg is canonical; mL only through a user-PICKED formulation/concentration.
//   • WEIGHT FRESHNESS. A weight older than an age-scaled threshold prompts to update
//     it BEFORE any band is suggested (kids grow; a stale band under-doses).
//   • The band amount is a SUGGESTION to confirm, carrying the label caveat — never
//     silently applied (that confirm is the liability line).

import { prnDefaultsFor } from "./prn-defaults";
import { parseAmountMg } from "./prn-redose";
import type {
  PediatricBand,
  PrnDefaultEntry,
  PrnFormulation,
  PrnPediatricDefaults,
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

// THE ONE SPELLING of "is this profile a child for label-dosing purposes" (#4672). It
// was written out three times — twice in the intake form and once privately here — and
// three copies of an age gate is three chances for one of them to drift past the
// label's own boundary. Takes the AGE rather than the context: the caller that has a
// context reads the months off it, and a primitive cannot be aliased by anything.
export function isChildProfileAge(
  ageMonths: number | null | undefined
): boolean {
  return ageMonths != null && ageMonths < PEDIATRIC_MAX_AGE_MONTHS;
}

// The subject's age in WHOLE YEARS, read off the same context the weight-band picker
// runs on (#4609). The food-note age gate (#851 item 4) asks in years while the dosing
// machinery asks in months, and the form used to take BOTH as separate props — so a
// host could pass the pediatric context and omit the age, and the form rendered a
// child's weight-band dosing above chronic-alcohol counselling that only an unknown age
// admits. One fact, one prop: ageMonths counts whole calendar months, so flooring to
// years lands on the same birthday boundary ageFromBirthdate computes, and the two can
// no longer disagree.
export function pediatricAgeYears(
  context: PediatricFormContext | undefined
): number | null {
  return context?.ageMonths == null ? null : Math.floor(context.ageMonths / 12);
}

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

// Whether the subject is past the last age the chart itself covers (#5539). The
// bound is the CHART's, read off the dataset entry — deliberately not the code's
// 216-month child test, which answers a different question (which surfaces a
// profile gets) and, reused here, is exactly what let a 16-year-old at 60 kg be
// handed the children's top band beside a prescribed dose.
export function isPediatricAboveChartAge(
  ped: PrnChartAgeRange,
  ageMonths: number
): boolean {
  return ageMonths >= ped.maxAgeMonths;
}
type PrnChartAgeRange = { maxAgeMonths: number };

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
  | { kind: "above-age-range"; ageMonths: number; maxAgeMonths: number } // past the chart
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
// entry. Order of decisions is deliberate: no-table → age gates (below the label's
// floor, then past the chart's last age) → no weight → stale weight →
// below-smallest-band refusal → the band dose. `formulationSlug` is the
// user's picked product concentration (mL only surfaces when it's set and known).
// An entry KNOWN to carry a chart cannot come back "no-pediatric" — that verdict is
// the absence of the table, and #4713's dose row would otherwise have to handle a
// case it has already excluded. Stated as an overload rather than re-checked at the
// call site (types over guards).
export function pediatricDoseSuggestion(input: {
  entry: PrnDefaultEntry & { pediatric: PrnPediatricDefaults };
  ageMonths: number;
  weightKg: number | null;
  weightDate: string | null;
  today: string;
  formulationSlug?: string | null;
}): Exclude<PediatricDoseResult, { kind: "no-pediatric" }>;
export function pediatricDoseSuggestion(input: {
  entry: PrnDefaultEntry;
  ageMonths: number;
  weightKg: number | null;
  weightDate: string | null;
  today: string;
  formulationSlug?: string | null;
}): PediatricDoseResult;
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
  // ABOVE the chart is answered here, beside the label's own floor and before the
  // weight questions, because no weight makes this chart cover this subject: asking
  // an adolescent's caregiver for a fresher weight would imply one would.
  if (isPediatricAboveChartAge(ped, input.ageMonths)) {
    return {
      kind: "above-age-range",
      ageMonths: input.ageMonths,
      maxAgeMonths: ped.maxAgeMonths,
    };
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

// The dose amount a formulation implies for a given milligram figure. It lives beside
// the band lookup because it is the band's ONE spelling as a stored string: the add
// form writes it into `intake_item_doses.amount`, the dose row offers it, and #4713's
// administration record stores it — one function, so those three can never disagree.
//
// THE VOLUME IS NOT STORED HERE, and that is the whole decision. #3216 asks a
// formulation switch to re-derive the dose "volume-first with strength equivalence",
// and a suspension's dose really is a volume — but the volume is already DERIVED at
// every display boundary by `formatMedicationDoseProduct`, which scales the product's
// concentration to the selected milligrams and renders "240 mg / 7.5 mL". So the
// switch re-derives `product`, and the amount stays milligrams.
//
// WHAT A VOLUME-LEADING AMOUNT WOULD COST. `parseAmountMg` (#1854) is anchored at a
// leading number + mass unit, so it reads "240 mg / 7.5 mL" perfectly well — an
// mg-leading string with the volume appended is NOT the hazard. The hazard is the
// literal reading of "volume-first": "7.5 mL (240 mg)" and "7.5 mL" both parse to
// null. And `prnDayExposure` treats an unreadable amount as a reason to abandon the
// milligram basis — `PrnExposureBasis` flips from "mg" to "count", so a confirmed
// mg/day ceiling silently stops being a mg/day ceiling and becomes a dose count.
// That would land on a child's liquid medicine, which is the single case where the
// milligram ceiling matters most (200 mg and 800 mg of the same ingredient are the
// same "dose" and four times the exposure). Nothing surfaces the downgrade.
//
// Storing BOTH would also put one datum in two columns, free to drift the moment
// someone edits one, and make `formatMedicationDoseProduct` render the concentration
// twice ("240 mg / 7.5 mL · 160 mg / 5 mL").
//
// The band PICKER still shows the volume beside each band — there it is a label the
// person reads before measuring, not a value the row stores.
export function formulationDoseAmount(mg: number): string {
  return `${mg} mg`;
}

// The one spelling of what a refusal SAYS. #798's gates are stated in two places now
// — the add form that sets the snapshot and, since #4713, the dose row that offers the
// band — and a refusal a caregiver reads at 2 a.m. must not be a second, drifting
// wording of the one they read when they added the medicine. Null for a dose, which is
// not a refusal.
export function pediatricRefusalLine(
  result: PediatricDoseResult | null | undefined
): string | null {
  switch (result?.kind) {
    case "ask-doctor":
      return result.reason;
    case "need-weight":
      return "Enter a current weight to match the package label’s weight band.";
    case "stale-weight":
      return `The latest recorded weight is over ${result.thresholdDays} days old. Enter a current weight before using a weight band.`;
    case "above-age-range":
      return `Recorded age is ${Math.floor(result.ageMonths / 12)} years. The available package-label chart covers children under ${Math.floor(result.maxAgeMonths / 12)} years, so no dose band is suggested. Check the product label and ask a clinician or pharmacist before use.`;
    case "below-weight-band":
      return `Recorded weight is ${result.weightLbs} lb. The available package-label chart starts at ${result.minimumLbs} lb, so no dose band is suggested. Check the product label and ask a clinician or pharmacist before use.`;
    default:
      return null;
  }
}

// The current label band is informational; recording still uses the item's stored
// dose. Label eligibility comes from the complete medication identity, independent
// of the amount's units. Only a milligram amount can be compared to the band figure.
export interface PrnDoseBandStatement {
  // The band's own figure as the row should spell it ("100 mg"), or null when the
  // label refuses. Never the row's offered amount — see above.
  bandAmount: string | null;
  // The band it came from ("24–35 lb"), for the row's basis line.
  bandLabel: string | null;
  // Whether the band's figure differs from the dose this item actually carries, so
  // the row can say which one it is offering. False when they agree, which is the
  // ordinary case: the add form's own band wrote that amount.
  differsFromStored: boolean;
  // The label's verdict, for the row to state — including for a dose written as a
  // volume. Null without a child context or an eligible label chart.
  result: Exclude<PediatricDoseResult, { kind: "no-pediatric" }> | null;
}

const NO_BAND: PrnDoseBandStatement = {
  bandAmount: null,
  bandLabel: null,
  differsFromStored: false,
  result: null,
};

export function prnDoseBandStatement(
  item: {
    identity: Parameters<typeof prnDefaultsFor>[0];
    product?: string | null;
    amount?: string | null;
  },
  context: PediatricFormContext | null | undefined
): PrnDoseBandStatement {
  if (!context) return NO_BAND;
  const { ageMonths } = context;
  if (ageMonths == null || !isChildProfileAge(ageMonths)) return NO_BAND;
  const entry = prnDefaultsFor(item.identity);
  const pediatric = entry?.pediatric;
  if (!entry || !pediatric) return NO_BAND;
  const result = pediatricDoseSuggestion({
    entry: { ...entry, pediatric },
    ageMonths,
    weightKg: context.weightKg,
    weightDate: context.weightDate,
    today: context.today,
    formulationSlug: formulationSlugForProduct(
      pediatric.formulations,
      item.product
    ),
  });
  // Refusals also apply to an eligible product whose dose is written as a volume.
  const storedMg = parseAmountMg(item.amount);
  if (result.kind !== "dose" || storedMg == null) return { ...NO_BAND, result };
  return {
    bandAmount: formulationDoseAmount(result.mg),
    bandLabel: result.bandLabel,
    differsFromStored: result.mg !== storedMg,
    result,
  };
}
