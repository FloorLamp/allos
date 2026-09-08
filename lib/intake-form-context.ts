// Gather the write subject's context once; every intake form requires this object.
// Callers authorize the subject profile before loading it.
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
  // branch `addIntakeItem` takes. Hosts pass this through; a host that recomputes the
  // day is the one way the seed and the staleness gate can disagree.
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
    // Start-date and weight-staleness checks share the subject's local day.
    todayStr: pediatric.today,
  };
}
