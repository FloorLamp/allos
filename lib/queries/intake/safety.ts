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

// One recorded (non-resolved) allergy with its row id + coded allergen — the
// drug-allergy × med cross-check's input (#1029). The id anchors the finding's
// dedupeKey (`allergy-med:<allergyId>-<itemId>`, id-keyed per #203); the code
// (RxNorm on the CCDA/FHIR drug-allergen paths) drives the authoritative match.
export interface SafetyAllergyRecord {
  id: number;
  substance: string;
  substanceCode: string | null;
  substanceCodeSystem: string | null;
  reaction: string | null;
}

// The shared safety context plus the active situations the food engine also screens
// against. A structural superset of SafetyContext, so it passes straight to
// screenSuggestionSafety.
export interface IntakeSafetyContext extends SafetyContext {
  // Active situation labels (getActiveSituations) — the food engine's caution screen.
  situations: string[];
  // The same non-resolved allergy set as `allergens`, with row ids + coded
  // allergens, for the drug-allergy cross-check (#1029). `allergens` (names only)
  // stays untouched for the belt/food consumers.
  allergyRecords: SafetyAllergyRecord[];
}

export function getIntakeSafetyContext(profileId: number): IntakeSafetyContext {
  // Non-resolved allergens only — a resolved allergy should not screen forever (the
  // food engine and the prompt's live-allergen list already use this set).
  const liveAllergies = getAllergies(profileId).filter(
    (a) => a.status !== "resolved"
  );
  const allergens = liveAllergies.map((a) => a.substance);
  const allergyRecords: SafetyAllergyRecord[] = liveAllergies.map((a) => ({
    id: a.id,
    substance: a.substance,
    substanceCode: a.substance_code,
    substanceCodeSystem: a.substance_code_system,
    reaction: a.reaction,
  }));
  const medications: SafetyMedication[] = getSupplements(profileId)
    .filter((s) => s.active && s.kind === "medication")
    .map((s) => ({
      id: s.id,
      name: s.name,
      rxcui: s.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    }));
  // Coded refs, not bare names (#1030): the row's code/code_system ride along so
  // every condition screen downstream (risk factors, contrast CKD, dental
  // cardiac, condition→nutrient) is code-first with the name fallback.
  const conditions = getConditions(profileId, { status: "active" }).map(
    (c) => ({ name: c.name, code: c.code, codeSystem: c.code_system })
  );
  const situations = getActiveSituations(profileId);
  return { allergens, allergyRecords, medications, conditions, situations };
}
