// Pure selection-prefill resolver for the medication add/edit form (issue #846).
// Given the datasets a PICKED medication resolves to (its curated educational entry
// carrying the `typical` conventions block, and its OTC PRN defaults) plus the
// profile's pediatric context and which fields the user has already TOUCHED, decide
// what to SUGGEST — each value editable, visibly marked ("from label defaults"), and
// NEVER clobbering a field the user already changed. No DB, no network: it's a pure
// function over the bundled datasets, so it lives in the pure test tier and both the
// full form and #843's future quick-add can reuse it.
//
// LIABILITY POSTURE (mirrors #798/#805): every suggestion is a PRE-FILL the user
// confirms/edits. ABSENT dataset ⇒ NO prefill, never a guess — an entry with no
// `typical` block simply doesn't prefill that field, and dose amounts come only from
// the cited OTC label figures (adult) or the #798 pediatric weight-band source (child).
// Nothing pharmacological is invented here.

import type { MedicationInfo } from "./medication-info";
import type { PrnDefaultEntry } from "./prn-defaults";
import {
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "./prn-dosing";
import type { FoodTiming } from "./types";
import type { TimeBucket } from "./supplement-schedule";

// Above this age no OTC pediatric weight-band chart applies — the child is dosed as
// an adult (mirrors the form's CHILD_MAX_AGE_MONTHS gate, #798).
const CHILD_MAX_AGE_MONTHS = 216; // 18 years

// The prefillable fields. Each maps to one form control the resolver may suggest.
export type PrefillField =
  | "asNeeded"
  | "doseAmount"
  | "minIntervalHours"
  | "maxDailyCount"
  | "foodTiming"
  | "timeOfDay";

export interface IntakePrefillInput {
  // The picked medication's curated educational entry (carries `typical` + brands),
  // or null when the name isn't in the catalog.
  info: MedicationInfo | null;
  // The picked medication's OTC PRN defaults (dose mg + interval/max + pediatric
  // bands), or null when the ingredient isn't in the #798 dataset.
  prn: PrnDefaultEntry | null;
  // The profile's pediatric-dosing context (#798). When present and the profile is a
  // child, a dose-amount suggestion comes from the pediatric weight band, not the
  // adult figure. Absent ⇒ adult dosing.
  pediatric?: PediatricFormContext | null;
  // Fields the user has already edited — never suggested over (never clobbered).
  touched?: Partial<Record<PrefillField, boolean>>;
}

export interface IntakePrefill {
  asNeeded?: boolean;
  doseAmount?: string;
  minIntervalHours?: number;
  maxDailyCount?: number;
  foodTiming?: FoodTiming;
  timeOfDay?: TimeBucket;
  // Brand-name autocomplete suggestions from the picked entry (e.g. Advil, Motrin).
  // Not a prefilled VALUE — the combobox options to offer. Empty when unknown.
  brandSuggestions: string[];
  // The fields actually suggested — the form marks each "from label defaults" and
  // clears the mark when the user edits it.
  marked: PrefillField[];
}

// Whether the profile is a child for whom the OTC pediatric weight-band chart, not
// the adult figure, is the dose-amount source (#798). Adult otherwise.
function isChild(pediatric: PediatricFormContext | null | undefined): boolean {
  return (
    pediatric != null &&
    pediatric.ageMonths != null &&
    pediatric.ageMonths < CHILD_MAX_AGE_MONTHS
  );
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

// The single prefill decision. Suggests each knowable field for which the datasets
// carry a value AND the user hasn't touched it; returns which fields were suggested
// so the form can mark them.
export function resolveIntakePrefill(input: IntakePrefillInput): IntakePrefill {
  const touched = input.touched ?? {};
  const typical = input.info?.typical ?? null;
  const marked: PrefillField[] = [];
  const out: IntakePrefill = {
    brandSuggestions: input.info?.brand_names ?? [],
    marked,
  };

  const suggest = <F extends PrefillField>(
    field: F,
    value: IntakePrefill[F] | null | undefined
  ) => {
    if (touched[field]) return; // never clobber a touched field
    if (value == null) return; // absent ⇒ no prefill
    (out as Record<PrefillField, unknown>)[field] = value;
    marked.push(field);
  };

  // Conventions from the curated `typical` block (label-standard only).
  suggest("asNeeded", typical?.asNeeded ? true : undefined);
  suggest("foodTiming", typical?.foodTiming);
  suggest("timeOfDay", typical?.timeOfDay);

  // Dose figures from the cited OTC label defaults (#798).
  suggest("doseAmount", resolveDoseAmount(input.prn, input.pediatric));
  if (input.prn) {
    suggest("minIntervalHours", input.prn.adult.minIntervalHours);
    suggest("maxDailyCount", input.prn.adult.maxDailyCount);
  }

  return out;
}
