// The ONE gather of a profile's intake-safety facts (issue #661): recorded allergens,
// active medications, active conditions, and active situations. Previously three
// surfaces each assembled their own copy of "this profile's active meds + allergens +
// conditions" — the AI supplement prompt + its deterministic belt (buildContext in
// lib/supplement-suggest), the food-suggestion engine (getFoodSuggestions in
// lib/queries/nutrition), and now the food-habit interaction note — which is exactly
// the input-layer drift #448 taught us to consolidate. This is that single gather; the
// consumers format over its result, so they can't disagree ("one question, one
// computation").
//
// Profile-scoped through the underlying reads (getAllergies/getConditions/
// getSupplements are all profile_id-filtered); no new SQL, so the profile-scoping
// guard is unaffected.

import type { SafetyContext, SafetyMedication } from "../../supplement-safety";
import { getAllergies, getConditions } from "../clinical";
import { getSupplements } from "./schedule";
import { getActiveSituations } from "../../settings";
import { parseRxcuiIngredients } from "../../rxnorm";

// The shared safety context plus the active situations the food engine also screens
// against. A structural superset of SafetyContext, so it passes straight to
// screenSuggestionSafety.
export interface IntakeSafetyContext extends SafetyContext {
  // Active situation labels (getActiveSituations) — the food engine's caution screen.
  situations: string[];
}

export function getIntakeSafetyContext(profileId: number): IntakeSafetyContext {
  // Non-resolved allergens only — a resolved allergy should not screen forever (the
  // food engine and the prompt's live-allergen list already use this set).
  const allergens = getAllergies(profileId)
    .filter((a) => a.status !== "resolved")
    .map((a) => a.substance);
  const medications: SafetyMedication[] = getSupplements(profileId)
    .filter((s) => s.active && s.kind === "medication")
    .map((s) => ({
      id: s.id,
      name: s.name,
      rxcui: s.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    }));
  const conditions = getConditions(profileId, { status: "active" }).map(
    (c) => c.name
  );
  const situations = getActiveSituations(profileId);
  return { allergens, medications, conditions, situations };
}
