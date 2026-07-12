// The read/gather layer for the nutrition domain (issues #577, #579, #580). The
// biomarker→food suggestions live here as the ONE computation both surfaces (biomarker
// detail page, coaching tab) format — "one question, one computation." The pure engine
// is lib/food-suggest.ts; this module only assembles its typed inputs from the
// profile-scoped reads and hands them over.

import { getCurrentFlaggedBiomarkers } from "./medical";
import { getAllergies, getConditions } from "./clinical";
import { getSupplements } from "./intake";
import { getActiveSituations } from "../settings";
import { parseRxcuiIngredients } from "../rxnorm";
import { suggestFoods, type FoodSuggestion } from "../food-suggest";
import type { SafetyMedication } from "../supplement-safety";

// Safety-screened food suggestions for the profile's currently-flagged, diet-responsive
// biomarker families. Deterministic; the AI narration tier (deferred, #576 Phase 3)
// would format over this same result. Empty when nothing diet-addressable is flagged.
export function getFoodSuggestions(profileId: number): FoodSuggestion[] {
  const flagged = getCurrentFlaggedBiomarkers(profileId).map((r) => ({
    name: r.name,
    flag: r.flag,
  }));
  if (flagged.length === 0) return [];

  const allergens = getAllergies(profileId)
    .filter((a) => a.status !== "resolved")
    .map((a) => a.substance);
  const medications: SafetyMedication[] = getSupplements(profileId)
    .filter((s) => s.active && s.kind === "medication")
    .map((s) => ({
      name: s.name,
      rxcui: s.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    }));
  const conditions = getConditions(profileId, { status: "active" }).map(
    (c) => c.name
  );
  const situations = getActiveSituations(profileId);

  return suggestFoods({
    flagged,
    allergens,
    medications,
    conditions,
    situations,
  });
}
