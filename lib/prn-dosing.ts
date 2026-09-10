// Reproduce a curated pediatric label chart within its age range, using a fresh
// recorded weight. Refusals never offer a dose; mL requires a selected concentration.

import { prnDefaultsFor } from "./prn-defaults";
import { doseBandUpdateKey } from "./dismissal-keys";
import { parseAmountMg } from "./prn-redose";
import type {
  PediatricBand,
  PrnDefaultEntry,
  PrnFormulation,
  PrnPediatricDefaults,
} from "./prn-defaults";
import type { PrefillLedger } from "./intake-prefill";
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
  // THE BAND-UPDATE OFFERS THIS SUBJECT HAS DECLINED (#5538) — the profile's active
  // `dose-band-update:` suppression keys. The offer to rewrite a stale stored dose is
  // derived from this context on four dose surfaces, so "have they already said no to
  // this figure?" rides the same object rather than becoming a fifth prop each host
  // has to remember to thread.
  declinedDoseUpdates: readonly string[];
}

// Shared child/adult boundary for every medication-form pediatric surface and its
// selection-prefill engine. Keeping this here prevents the quick, full, and edit
// paths from drifting onto different age gates.
export const PEDIATRIC_MAX_AGE_MONTHS = 216; // 18 years

// Profile age tier controls medication surfaces; each chart owns its age range.
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
  if (input.ageMonths >= ped.maxAgeMonths) {
    return {
      kind: "ask-doctor",
      reason: `The available package-label chart is for children under ${ped.maxAgeMonths / 12} years, so no dose band is suggested. Check the product label and ask a clinician or pharmacist before use.`,
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

// Store milligrams so exposure accounting retains its mg/day basis. Presentation
// derives volume from the selected product's concentration; do not store it twice.
export function formulationDoseAmount(mg: number): string {
  return `${mg} mg`;
}

// ---- The re-offer after a new weight (#798, #851 item 8) --------------------

// What a fresh weight does to the dose the label already offered. Three answers, and
// only three:
//   • OFFER  — the new weight lands in a band, and the amount on screen is either the
//              label's own earlier offer or still blank;
//   • WITHDRAW — the new weight yields no dose at all (an age gate, a stale or missing
//              weight, or a weight below the smallest band). Leaving the old figure
//              standing would attribute a dose to a measurement that no longer
//              supports it, which is #798's refusal posture inverted;
//   • KEEP   — the new weight bands, but the amount belongs to the CAREGIVER (typed by
//              hand, or read back off a saved row). A weight update never rewrites a
//              person's own number.
//
// The ledger answers "is this figure still the label's?" for the first two. The extra
// empty-check is the one thing it cannot answer: a stored row's amount was never
// offered and never marked touched, so an edit-mode blank still counts as free.
//
// IT TAKES NO FORMULATION, and that is a property rather than an omission. The offered
// figure is `band.mg`, read off the WEIGHT band; the picked product feeds only `ml` and
// the formulation label, which this policy never reads. That is the stored-once rule
// `formulationDoseAmount` above states — milligrams are stored, volume is derived at
// every display boundary — so a concentration cannot move the amount by construction.
// Threading a slug in here would advertise a dependency the architecture forbids, and
// the next reader of a safety policy would budget care for it.
export type PediatricReoffer =
  | { kind: "offer"; doseAmount: string }
  | { kind: "withdraw" }
  | { kind: "keep" };

export function reofferPediatricDose(input: {
  // Null when the name resolves to no curated PRN entry — nothing to re-derive.
  entry: PrnDefaultEntry | null | undefined;
  next: PediatricFormContext;
  ledger: PrefillLedger;
  currentAmount: string;
}): PediatricReoffer {
  const { entry, next } = input;
  // No entry and no age are the same answer: there is no chart to re-read, so the
  // amount on screen is not the label's to change.
  if (!entry || next.ageMonths == null) return { kind: "keep" };
  const result = pediatricDoseSuggestion({
    entry,
    ageMonths: next.ageMonths,
    weightKg: next.weightKg,
    weightDate: next.weightDate,
    today: next.today,
  });
  if (result.kind !== "dose") return { kind: "withdraw" };
  const offered = input.ledger.suggested.has("doseAmount");
  return offered || !input.currentAmount.trim()
    ? { kind: "offer", doseAmount: formulationDoseAmount(result.mg) }
    : { kind: "keep" };
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
  // ordinary case: the add form's own band wrote that amount. SYMMETRIC on purpose —
  // the row must state a chart that reads LOWER than the stored figure just as plainly
  // as one that reads higher. The offer below does not read this; see `exceedsStored`.
  differsFromStored: boolean;
  // The same comparison in ONE DIRECTION: the band's figure is strictly HIGHER than the
  // stored dose. This is the update offer's gate (owner ruling 3 on #5538) and the only
  // difference between the two fields. A label chart states its figure either way but
  // never proposes CUTTING a prescriber's — and `intake_items.rx` cannot carry the
  // downward case, because an imported prescription can land flagged OTC. Both are
  // false unless a milligram figure was read off the stored amount, so an amount that
  // is not comparable to a milligram band (a volume, a count, IU, free text) is never a
  // higher band.
  exceedsStored: boolean;
  // The label's verdict, for the row to state — including for a dose written as a
  // volume. Null without a child context or an eligible label chart.
  result: Exclude<PediatricDoseResult, { kind: "no-pediatric" }> | null;
}

const NO_BAND: PrnDoseBandStatement = {
  bandAmount: null,
  bandLabel: null,
  differsFromStored: false,
  exceedsStored: false,
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
    exceedsStored: result.mg > storedMg,
    result,
  };
}

// ── THE STALE STORED DOSE, AND THE OFFER THAT FIXES IT (issue #5538) ─────────
//
// `prnDoseBandStatement` above already STATES the band beside a stored amount that
// disagrees with it (#4713 item 1). What it cannot do is move the amount: nothing in
// `intake_item_doses` separates a figure a band suggested from one a prescriber set,
// so a lookup that refreshes the first necessarily overwrites the second — the defect
// that got #4713's item 3 withdrawn, and the reason the invariant at the top of this
// file says a band amount is a SUGGESTION to confirm, never silently applied.
//
// The owner's ruling is to follow the current weight and ASK. When the band's figure is
// HIGHER than the item's stored dose, the dose row offers to rewrite the stored amount
// ONCE; accepting means every later tap records the new figure, declining writes no
// health data and no dose amount at all. The tap itself is never gated — there is no
// per-tap confirm and no provenance column.
//
// UPWARD ONLY (ruling 3). A growing child is the case this exists for. The reverse — a
// prescriber's 300 mg beside a chart that reads 150 mg — is NOT offered: an OTC label
// chart is not authority over a prescription, and the item's Rx flag is not a safe
// enough gate to tell the two apart. That case is out of scope here, and the row still
// STATES the chart's figure beside the stored one, which is `differsFromStored`'s job.
//
// ONE DERIVATION, FOUR HOSTS. The medications Today panel, the medicine card's Today
// block, the illness cockpit's Meds fold and the quick-entry sheet all mount the same
// dose row and all already carry the subject's pediatric context, so the offer is
// derived here — from the same two arguments the band statement takes — rather than
// four times over.
export interface PrnDoseUpdateOffer {
  /** The suppression-bus key this offer lives under; the answer path's only token. */
  key: string;
  /** The band figure accepting writes, as the row spells it ("150 mg"). */
  bandAmount: string;
  /** The item's stored dose as it stands today ("100 mg"). */
  storedAmount: string;
  /** One question, two verbs — the shared in-place offer's vocabulary. */
  question: string;
  yes: string;
  no: string;
}

export interface PrnDoseUpdateItem {
  id: number;
  /** The medicine as the surface names it — a dose statement names its drug. */
  name: string;
  identity: Parameters<typeof prnDefaultsFor>[0];
  product?: string | null;
  amount?: string | null;
}

export function prnDoseUpdateOffer(
  item: PrnDoseUpdateItem,
  context: PediatricFormContext | null | undefined
): PrnDoseUpdateOffer | null {
  const band = prnDoseBandStatement(item, context);
  const storedAmount = item.amount;
  // `exceedsStored` is already exactly "a child, an eligible chart, a fresh weight, a
  // milligram amount on file, and the band reads higher" — the case this offer exists
  // for and nothing else. The result narrowing carries the band's own mg out of the
  // union; the stored amount is what produced `exceedsStored`.
  if (!band.exceedsStored || band.result?.kind !== "dose" || !storedAmount)
    return null;
  const key = doseBandUpdateKey(item.id, band.result.mg);
  if (context?.declinedDoseUpdates.includes(key)) return null;
  const bandAmount = formulationDoseAmount(band.result.mg);
  return {
    key,
    bandAmount,
    storedAmount,
    // Names the medicine and both amounts, then what accepting does. The band line
    // directly above already says which weight band the new figure comes from, so the
    // question does not repeat it.
    question: `${item.name} is set to ${storedAmount}. Update it to ${bandAmount}?`,
    yes: `Update to ${bandAmount}`,
    no: `Keep ${storedAmount}`,
  };
}

// AT MOST ONE OFFER PER SURFACE (the placement ruling). A list host renders one dose
// row per PRN, and a sick child with three charted PRNs would otherwise meet three
// boxes at once — the same argument the row's weight fixer already makes for opening
// one editor rather than several. The seat goes to the first row that would offer, in
// the order the surface renders them; a host that mounts a single dose row needs no
// seat at all.
export function doseUpdateOfferSeat(
  items: readonly PrnDoseUpdateItem[],
  context: PediatricFormContext | null | undefined
): number | null {
  return items.find((item) => prnDoseUpdateOffer(item, context))?.id ?? null;
}
