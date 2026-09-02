// THE ONE INTAKE-FORM CONTEXT (#4609). Everything `IntakeItemForm` needs about the
// SUBJECT of the write, gathered once, so a door cannot open with half of it. The form
// was fed by whichever host mounted it and the hosts disagreed: /medications passed the
// full set, the illness add fold passed the pediatric context alone. Same form, same
// profile, different safety surface — a child got chronic-alcohol counselling because
// the food-note age gate ran on "unknown", and the stack, PGx and pairing controls had
// nothing in them. Nothing marked that door as degraded; it looked complete.
//
// KEYED ON THE SUBJECT, NOT ON WHO IS LOOKING — the parameter is the profile the item
// is recorded FOR, so a caregiver opening this door for a child gets the CHILD's age,
// stack, variants and conditions. Authorization stays at the request boundary: the
// caller resolves which profile it may write and passes that id.
import type { InteractionItem } from "./drug-interactions";
import { parseRxcuiIngredients } from "./rxnorm";
import type { PgxVariantInput } from "./pgx";
import type { PediatricFormContext } from "./prn-dosing";
import {
  getConditions,
  getGenomicVariants,
  getIntakeIngredientsByItem,
  getIntakeItems,
  getPediatricFormContext,
} from "./queries";
import type { WeightUnit } from "./settings";
import type { IntakeConditionOption, IntakeItem } from "./types";

export interface IntakeFormContext {
  // The profile's own items: the pairing editor's "with which other item" list, and
  // the identity a candidate is checked against.
  allIntakeItems: IntakeItem[];
  // The active stack the candidate is cross-checked against for interactions.
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  // With status (#3650): the pickers offer the active ones and must still be able to
  // name a purpose declared against one since resolved.
  conditions: IntakeConditionOption[];
  // The form's ONE source of the subject's age: the weight-band picker and the
  // food-note age gate both read it, so a door that can render pediatric dosing cannot
  // also gate on an unknown age.
  pediatric: PediatricFormContext;
  // The profile-local day, for the start-date seed. Its absence is not cosmetic — it
  // decides whether the form posts `started_on` at all, and therefore which validation
  // branch `addIntakeItem` takes.
  todayStr: string;
}

export function loadIntakeFormContext(
  profileId: number,
  weightUnit: WeightUnit = "kg"
): IntakeFormContext {
  const allIntakeItems = getIntakeItems(profileId);
  const ingredientsByItem = getIntakeIngredientsByItem(profileId);
  const pediatric = getPediatricFormContext(profileId, weightUnit);
  return {
    allIntakeItems,
    stackItems: allIntakeItems.map((item) => ({
      id: item.id,
      name: item.name,
      rxcui: item.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(item.rxcui_ingredients),
      ingredients: (ingredientsByItem.get(item.id) ?? []).map((g) => g.name),
      active: !!item.active,
    })),
    pgxVariants: getGenomicVariants(profileId)
      .filter((v) => v.result_type === "pharmacogenomic")
      .map((v) => ({
        id: v.id,
        gene: v.gene,
        star_allele: v.star_allele,
        genotype: v.genotype,
        variant: v.variant,
        interpretation: v.interpretation,
        notes: v.notes,
      })),
    conditions: getConditions(profileId).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
    })),
    pediatric,
    // The same profile-local day the pediatric context resolved, so the weight-staleness
    // reading and the start-date seed cannot land on different days.
    todayStr: pediatric.today,
  };
}
