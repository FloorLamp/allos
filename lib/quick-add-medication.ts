// Pure field-mapping for the OTC medication quick-add (issue #843, door C). The
// quick-add collapses the common case — an over-the-counter PRN med (ibuprofen,
// acetaminophen) reached for the moment you feel sick — to name + amount + a PRN
// preset. It creates the SAME intake_items row the full MedicationForm would: it posts
// the identical field names to the SAME `addSupplement` action, so there's no second
// write model and no migration. This module owns the name→field mapping so BOTH the
// client quick-add form and the row-parity action test share ONE computation (the
// "one question, one computation" rule at the create seam).
//
// The pharmacological suggestions the form fills (dose amount, redose interval/max,
// brand names, pediatric bands) come from the #846 resolver over the cited #798 OTC
// datasets — this module only shapes the CONFIRMED values into the action's fields.

import { serializeRxcuiIngredients } from "./rxnorm";

export interface QuickAddMedicationInput {
  // The medication name (generic), required — a blank name is rejected by the action.
  name: string;
  // A brand ("Advil"), optional — split out of a brand pick by the #817 combobox.
  brand?: string | null;
  // The selected formulation label (for example "Children's oral suspension
  // (160 mg / 5 mL)"). Stored in intake_items.product so it survives quick add.
  product?: string | null;
  // The single dose strength ("200 mg"), optional — the one dose row's amount.
  amount?: string | null;
  // Whether it's an as-needed (PRN) med. OTC quick-adds are PRN by design, but kept a
  // flag so the mapping stays honest.
  asNeeded: boolean;
  // The confirmed redose interval / daily max (from the OTC label defaults, #798).
  // Carried only for a PRN med; a blank/zero value is dropped (NO redose notice).
  minIntervalHours?: number | null;
  maxDailyCount?: number | null;
  // Whether the user opted in to the redose reminder (#798 liability confirm). Only
  // honored when both interval and max are present.
  redoseNotice?: boolean;
  // Cached RxNorm concept id + active-ingredient CUIs (#144/#279), when confirmed.
  rxcui?: string | null;
  rxcuiIngredients?: string[] | null;
}

// The intake-form field entries the quick-add submits — the SAME names `addSupplement`
// reads (kind='medication', condition='daily', the PRN interval/max, one dose row). A
// blank/absent field is OMITTED so the action's own defaults (priority 'high', etc.)
// apply exactly as they do for the full form. Returned as [key, value] pairs so a
// caller can fold them into a FormData.
export function quickAddMedicationFields(
  input: QuickAddMedicationInput
): [string, string][] {
  const out: [string, string][] = [];
  const push = (k: string, v: string | null | undefined) => {
    if (v != null && v !== "") out.push([k, v]);
  };

  push("name", input.name.trim());
  push("kind", "medication");
  // A quick-add med is a plain daily-context PRN — no workout/situation gating.
  push("condition", "daily");
  push("brand", input.brand?.trim() || null);
  push("product", input.product?.trim() || null);

  if (input.asNeeded) {
    out.push(["as_needed", "1"]);
    const interval =
      input.minIntervalHours != null && input.minIntervalHours > 0
        ? input.minIntervalHours
        : null;
    const max =
      input.maxDailyCount != null && input.maxDailyCount > 0
        ? input.maxDailyCount
        : null;
    if (interval != null) push("min_interval_hours", String(interval));
    if (max != null) push("max_daily_count", String(max));
    // The redose reminder is opt-in and only fires when BOTH numbers are confirmed
    // (mirrors addSupplement's own gate) — an opt-in with nothing confirmed is dropped.
    if (input.redoseNotice && interval != null && max != null)
      out.push(["redose_notice", "1"]);
  }

  push("rxcui", input.rxcui?.trim() || null);
  if (input.rxcui?.trim() && input.rxcuiIngredients?.length) {
    push(
      "rxcui_ingredients",
      serializeRxcuiIngredients(input.rxcuiIngredients)
    );
  }

  // One dose row — the same JSON shape the full form posts (parseDoses coerces a blank
  // amount to null and defaults food_timing to 'any').
  const amount = input.amount?.trim() || null;
  out.push([
    "doses",
    JSON.stringify([{ amount, food_timing: "any", time_of_day: "" }]),
  ]);

  return out;
}

// Build the FormData the client quick-add posts to `addSupplement`.
export function quickAddMedicationFormData(
  input: QuickAddMedicationInput
): FormData {
  const fd = new FormData();
  for (const [k, v] of quickAddMedicationFields(input)) fd.set(k, v);
  return fd;
}
