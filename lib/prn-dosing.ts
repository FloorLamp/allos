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

import { prnDefaultsFor } from "./prn-defaults";
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

// What one PRN dose row offers, and what its tap writes (#4713).
//
// THE BAND RUNS AT THE TAP, NOT ONLY AT ADD TIME. The machinery above had exactly one
// consumer — the add/edit medication form — so a child's dose row rendered the
// `amount` SNAPSHOT the band produced whenever the item was last edited. A growing
// child's snapshot said 160 mg; three months later the tap still wrote 160 mg with
// nothing re-deriving it, and the staleness refusals below were unreachable from the
// only surface anybody opens to give a dose at 2 a.m.
//
// MATCHED BY NAME, DELIBERATELY. The quick-log projection carries no RxCUI (the same
// row `antipyreticPrnMeds` already matches name-only, for the same reason), and the
// row and the WRITE must resolve the same entry or the record would state a figure the
// reader was never shown — #4753's primitive, that a chip's label is its payload. So
// both sides run this one function over the same two fields.
//
// A REFUSAL DOES NOT BLOCK THE TAP. #798's gates decide what the LABEL suggests, and
// this moves where they run, not what they decide: the add form states a refusal and
// still saves, and a caregiver who has already given a dose must still be able to
// record it. `amount` therefore falls back to the stored snapshot for every non-dose
// verdict, and the row states the refusal beside it.
export interface PrnDoseRowOffer {
  // The amount the row offers and the tap records: the label band's figure when one
  // is derivable, else the item's stored snapshot (adults, no-band items, refusals).
  amount: string | null;
  // The band the amount came from ("24–35 lb"), for the row's basis line. Null
  // whenever `amount` is the stored snapshot — which is also what tells the write
  // path there is nothing to override.
  bandLabel: string | null;
  // The label's verdict, for the row to state. Null for an adult profile or an item
  // with no pediatric chart — the byte-identical path, and the reason "no-pediatric"
  // is not among the verdicts a caller has to handle: an entry without a chart never
  // reaches the lookup.
  result: Exclude<PediatricDoseResult, { kind: "no-pediatric" }> | null;
}

export function prnDoseRowOffer(
  item: { name: string; product?: string | null; amount?: string | null },
  context: PediatricFormContext | null | undefined
): PrnDoseRowOffer {
  const snapshot: PrnDoseRowOffer = {
    amount: item.amount ?? null,
    bandLabel: null,
    result: null,
  };
  if (!context) return snapshot;
  const { ageMonths } = context;
  if (ageMonths == null || !isChildProfileAge(ageMonths)) return snapshot;
  const entry = prnDefaultsFor({
    name: item.name,
    rxcui: null,
    rxcuiIngredients: null,
  });
  const pediatric = entry?.pediatric;
  if (!entry || !pediatric) return snapshot;
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
  if (result.kind !== "dose") return { ...snapshot, result };
  return {
    amount: formulationDoseAmount(result.mg),
    bandLabel: result.bandLabel,
    result,
  };
}
