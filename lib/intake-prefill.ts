// The ONE prefill discipline of the intake form (#846, #4665).
//
// TWO QUESTIONS, ONE ANSWER EACH. A seed path asks two things: what does this
// vocabulary OFFER for the picked thing, and MAY I write it? `resolveIntakePrefill`
// answers the first for all three vocabularies the form picks from; the ledger answers
// the second for every path. Before #4665 the second question had four answers living
// in four places — a `touched` set, a `suggestedFields` set, `applyProductSeed`'s
// previous-seed comparison, and bare empty-checks — and where they disagreed the
// disagreement was a bug: a formulation switch overwrote hand-typed redose figures, two
// of three pick arms seeded without marking, and one arm REPLACED the marks another had
// made. None of the three is representable through `applyPrefill`.
//
// LIABILITY POSTURE (mirrors #798/#805): every suggestion is a PRE-FILL the user
// confirms/edits. ABSENT dataset ⇒ NO prefill, never a guess — an entry with no
// `typical` block simply doesn't prefill that field, and dose amounts come only from
// the cited OTC label figures (adult) or the #798 pediatric weight-band source (child).
// Nothing pharmacological is invented here.
//
// Pure: no React, no DB, no network — the bundled datasets and the ledger, nothing else.

import type { MedicationInfo } from "./medication-info";
import { redoseLabelDefaults, type PrnDefaultEntry } from "./prn-defaults";
import {
  isChildProfileAge,
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "./prn-dosing";
import type { SupplementCatalogEntry } from "./supplement-catalog";
import { defaultFoodTiming, type TimeBucket } from "./intake-schedule";
import type { FoodTiming } from "./types";

// The prefillable fields. Each maps to one form control a seed path may offer a value
// for; `PREFILL_FIELDS` is the enumeration every ledger operation walks, so a new field
// is added in exactly one place. A field is only as protected as its control's marking,
// so the enumeration is also what the form's census walks control by control
// (components/__tests__/intake-prefill-ledger.test.tsx) — `foodTiming`, whose control is
// the rules builder rather than an input of its own, went unmarked until it did.
export type PrefillField =
  | "asNeeded"
  | "doseAmount"
  | "minIntervalHours"
  | "maxDailyCount"
  | "foodTiming"
  | "timeOfDay";

export const PREFILL_FIELDS = [
  "asNeeded",
  "doseAmount",
  "minIntervalHours",
  "maxDailyCount",
  "foodTiming",
  "timeOfDay",
] as const satisfies readonly PrefillField[];

// The values a seed path may offer, one optional entry per field. An absent entry is
// "this vocabulary states nothing here" — never "clear it".
export interface PrefillValues {
  asNeeded?: boolean;
  doseAmount?: string;
  minIntervalHours?: number;
  maxDailyCount?: number;
  foodTiming?: FoodTiming;
  timeOfDay?: TimeBucket;
}

// ---- The ledger ----
//
// `suggested` marks facts still showing a dataset's offer, so the row states them as
// offers rather than as things the person said (#846's marking guarantee). `touched`
// records what the person edited, so no LATER seed can write over it. The two are one
// structure because they are one question asked twice.
export interface PrefillLedger {
  readonly suggested: ReadonlySet<PrefillField>;
  readonly touched: ReadonlySet<PrefillField>;
}

export function emptyPrefillLedger(): PrefillLedger {
  return { suggested: new Set(), touched: new Set() };
}

export interface AppliedPrefill {
  ledger: PrefillLedger;
  // The subset of the offer the ledger permits. A caller writes exactly these.
  writes: PrefillValues;
}

// May I write this? — asked once, for every field of an offer, by every seed path.
//
// A touched field is refused outright. Everything written is marked suggested, and the
// marks MERGE: a path that seeds one field never silently un-marks what another path
// seeded, which is the guarantee replacing the set used to break.
export function applyPrefill(
  ledger: PrefillLedger,
  offer: PrefillValues
): AppliedPrefill {
  const writes: PrefillValues = {};
  const suggested = new Set(ledger.suggested);
  for (const field of PREFILL_FIELDS) {
    const value = offer[field];
    if (value === undefined) continue;
    if (ledger.touched.has(field)) continue;
    (writes as Record<PrefillField, unknown>)[field] = value;
    suggested.add(field);
  }
  return { ledger: { suggested, touched: ledger.touched }, writes };
}

// The person edited these. They stop being an offer and become theirs.
export function touchPrefill(
  ledger: PrefillLedger,
  ...fields: PrefillField[]
): PrefillLedger {
  const suggested = new Set(ledger.suggested);
  const touched = new Set(ledger.touched);
  for (const field of fields) {
    suggested.delete(field);
    touched.add(field);
  }
  return { suggested, touched };
}

// Withdraw an offer the datasets no longer stand behind (a new weight with no band).
// Only ever applied to a field still showing the offer — a touched field is the
// person's and is never cleared out from under them.
export function withdrawPrefill(
  ledger: PrefillLedger,
  field: PrefillField
): PrefillLedger {
  const suggested = new Set(ledger.suggested);
  suggested.delete(field);
  return { suggested, touched: ledger.touched };
}

// ---- The three vocabularies ----
//
// The form's one Name field offers rows from three sources, and before #4665 each had
// its own resolver: the medication arm called this module, the supplement catalog arm
// hand-wrote thirty-five lines producing the same shape, and the bottle arm bypassed
// both. They are three vocabularies answering ONE question, so they are three arms of
// one function.
// The two LABEL vocabularies — a curated dataset describing a typical product.
export type IntakeLabelSource =
  // A picked medication: its curated educational entry (carrying the `typical`
  // conventions block and its brands) and its OTC PRN defaults. Either may be null.
  | {
      vocabulary: "medication";
      info: MedicationInfo | null;
      prn: PrnDefaultEntry | null;
    }
  // A picked supplement catalog entry: a committed label with its own dosages, time of
  // day, food relationship and (for a blend) composition.
  | { vocabulary: "catalog"; entry: SupplementCatalogEntry };

export type IntakePrefillSource =
  | IntakeLabelSource
  // A picked household bottle (#1705). The pool is authoritative for the product's
  // STRENGTH — it is the bottle actually in the house, which is a more specific answer
  // than any dataset's typical figure, so it STANDS OVER the label's dose amount
  // (#4608). The bottle's NAME is product identity rather than a label figure and is
  // seeded by the caller. A bottle whose name also resolves to a label carries it: the
  // bottle states the strength, the label states the conventions around it.
  | { vocabulary: "bottle"; amount: string; label?: IntakeLabelSource | null };

export interface IntakePrefillInput {
  source: IntakePrefillSource;
  // The profile's pediatric-dosing context (#798). When present and the profile is a
  // child, a dose-amount suggestion comes from the pediatric weight band, not the
  // adult figure. Absent ⇒ adult dosing.
  pediatric?: PediatricFormContext | null;
  // What the person has already edited, and what is still showing as an offer.
  ledger: PrefillLedger;
}

export interface IntakePrefill extends AppliedPrefill {
  // Brand-name autocomplete suggestions from a picked medication entry (e.g. Advil,
  // Motrin). Not a prefilled VALUE — the combobox options to offer. Empty when unknown.
  brandSuggestions: string[];
  // A catalogued blend's label composition, per single dose unit (#2856), and the
  // sentence saying how much of the label it is. The ingredients repeater owns these
  // rows rather than the ledger, but the same pick decides them, so one resolver
  // answers for them too. Empty for the other vocabularies.
  ingredients: { name: string; amount: string }[];
  ingredientNote: string | null;
}

// Whether the profile is a child for whom the OTC pediatric weight-band chart, not the
// adult figure, is the dose-amount source (#798). Adult otherwise.
function isChild(pediatric: PediatricFormContext | null | undefined): boolean {
  return isChildProfileAge(pediatric?.ageMonths);
}

// Resolve the dose-amount suggestion: the pediatric weight-band mg for a child (only
// when the band actually resolves to a dose — a refusal/needs-weight yields no
// prefill, the form's own pediatric block surfaces that), else the adult OTC low
// dose. Null when the ingredient has no PRN defaults.
function resolveDoseAmount(
  prn: PrnDefaultEntry | null,
  pediatric: PediatricFormContext | null | undefined
): string | null {
  if (!prn) return null;
  if (isChild(pediatric) && prn.pediatric && pediatric) {
    const ped = pediatricDoseSuggestion({
      entry: prn,
      ageMonths: pediatric.ageMonths as number,
      weightKg: pediatric.weightKg,
      weightDate: pediatric.weightDate,
      today: pediatric.today,
    });
    // Pediatric band prefill ONLY from the #798 source band — a refusal (age gate,
    // missing/stale weight, below-band) prefills nothing, never the adult figure.
    return ped.kind === "dose" ? `${ped.mg} mg` : null;
  }
  return `${prn.adult.doseMgLow} mg`;
}

// What a picked medication OFFERS, before the ledger decides what may be written.
function medicationOffer(
  info: MedicationInfo | null,
  prn: PrnDefaultEntry | null,
  pediatric: PediatricFormContext | null | undefined
): PrefillValues {
  const typical = info?.typical ?? null;
  const offer: PrefillValues = {};
  // Conventions from the curated `typical` block (label-standard only).
  if (typical?.asNeeded) offer.asNeeded = true;
  if (typical?.foodTiming) offer.foodTiming = typical.foodTiming;
  if (typical?.timeOfDay) offer.timeOfDay = typical.timeOfDay;
  // Dose figures from the cited OTC label defaults (#798).
  const dose = resolveDoseAmount(prn, pediatric);
  if (dose != null) offer.doseAmount = dose;
  // Redose interval / daily-max, AGE-AWARE (issue #851 item 12): the pediatric label
  // figures for a child when they differ, the adult figures for an adult/unknown age,
  // and — critically — NO prefill for a child when the ingredient carries no pediatric
  // label figure (never guess below the label's floor; the adult max would over-dose a
  // child, e.g. acetaminophen 6 vs 5). redoseLabelDefaults encodes the refusal.
  if (prn) {
    const redose = redoseLabelDefaults(prn, isChild(pediatric));
    if (redose) {
      offer.minIntervalHours = redose.minIntervalHours;
      offer.maxDailyCount = redose.maxDailyCount;
    }
  }
  return offer;
}

// What a picked supplement catalog entry offers. The food relationship falls back to
// the fat-soluble heuristic over the entry's own name and composition, exactly as the
// form's hand-written arm did.
function catalogOffer(entry: SupplementCatalogEntry): PrefillValues {
  const composition = entry.ingredients ?? [];
  const offer: PrefillValues = {
    foodTiming: defaultFoodTiming(
      entry.name,
      entry.defaultFoodTiming,
      composition.map((g) => g.name)
    ),
  };
  const dosage = entry.dosages[0];
  if (dosage) offer.doseAmount = dosage;
  if (entry.defaultTimeOfDay) offer.timeOfDay = entry.defaultTimeOfDay;
  return offer;
}

// The single prefill decision: what the picked vocabulary offers, narrowed to what the
// ledger permits, with the ledger the caller carries forward.
export function resolveIntakePrefill(input: IntakePrefillInput): IntakePrefill {
  const { source } = input;
  const label: IntakeLabelSource | null =
    source.vocabulary === "bottle" ? (source.label ?? null) : source;
  const offer: PrefillValues = label
    ? label.vocabulary === "medication"
      ? medicationOffer(label.info, label.prn, input.pediatric)
      : catalogOffer(label.entry)
    : {};
  // The bottle in the house outranks the label's typical figure.
  if (source.vocabulary === "bottle" && source.amount)
    offer.doseAmount = source.amount;

  const applied = applyPrefill(input.ledger, offer);
  const composition =
    label?.vocabulary === "catalog" ? (label.entry.ingredients ?? []) : [];
  return {
    ...applied,
    brandSuggestions:
      label?.vocabulary === "medication" ? (label.info?.brand_names ?? []) : [],
    ingredients: composition.map((g) => ({
      name: g.name,
      amount: g.amount ?? "",
    })),
    ingredientNote:
      label?.vocabulary === "catalog" && composition.length > 0
        ? label.entry.ingredientsPartial
          ? `Prefilled with the part of the ${label.entry.name} label these checks use — not the whole label. Check it against your own bottle and add anything missing.`
          : `Prefilled from a typical ${label.entry.name} label. Check it against your own bottle.`
        : null,
  };
}
