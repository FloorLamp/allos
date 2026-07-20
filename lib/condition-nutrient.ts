// Curated condition→nutrient contraindication rules (issue #657), DERIVED from the
// SAME nutrient-food-map the food-suggestion engine hard-drops on (#577). The food
// engine already withholds a nutrient's food suggestion when an active condition
// carries a "drop"-severity contraindication (CKD × potassium/magnesium is the
// anchor); this module re-exposes that exact curated data so the deterministic
// SUPPLEMENT belt (lib/supplement-safety.ts) and the UL-caveat annotation (lib/dri.ts)
// draw their condition rules from ONE place — the three surfaces can never disagree
// about which condition contraindicates a nutrient ("one question, one computation").
//
// Pure (reads the committed JSON only). Exclusion discipline mirrors the dataset's:
// only well-established, citable condition→nutrient rules — the map is the sourcing
// standard, not a second hand-rolled list.

import {
  conditionCodeConcepts,
  conditionInputName,
  type ConditionConcept,
  type ConditionInput,
} from "./condition-codes";
import { NUTRIENT_FOOD_ENTRIES } from "./datasets/nutrient-food-map";

const ENTRIES = NUTRIENT_FOOD_ENTRIES;

// A DROP-severity condition→nutrient contraindication.
export interface ConditionNutrientRule {
  // The nutrient-food-map entry key, e.g. "magnesium" — also the dri.json nutrient key
  // where the two datasets name the same nutrient.
  nutrientKey: string;
  // The tokens a supplement NAME might carry for this nutrient (for the belt's
  // name-token screen), e.g. ["potassium"].
  nutrientTokens: string[];
  // The lowercased condition substring that triggers the rule (from the map).
  match: string;
  // The curated caution copy shown when it hits.
  caution: string;
}

// nutrient slug → the ingredient tokens a supplement name carries. Default is the slug
// with hyphens spaced ("vitamin-d" → "vitamin d"); the drop-bearing nutrients are
// single words, so the default already covers the anchor cases.
const NUTRIENT_NAME_TOKENS: Record<string, string[]> = {
  potassium: ["potassium"],
  magnesium: ["magnesium"],
};

function tokensForNutrient(key: string): string[] {
  return NUTRIENT_NAME_TOKENS[key] ?? [key.replace(/-/g, " ")];
}

// Every drop-severity condition→nutrient rule the curated map declares. Only "drop"
// severity feeds the hard belt / UL caveat; "caution"-severity map tags stay in the
// food engine's annotate-only path.
export const CONDITION_NUTRIENT_RULES: ConditionNutrientRule[] =
  ENTRIES.flatMap((e) =>
    (e.contraindications ?? [])
      .filter((c) => (c.severity ?? "caution") === "drop")
      .map((c) => ({
        nutrientKey: e.key,
        nutrientTokens: tokensForNutrient(e.key),
        match: c.match.trim().toLowerCase(),
        caution: c.caution,
      }))
  );

// The coded half of the condition→nutrient matching (#1030): which curated code
// CONCEPTS (lib/condition-codes) satisfy which dataset `match` term. Only the
// drop-severity terms with a clean code family get an entry (exclusion
// discipline); a term absent here matches by name substring exactly as before.
const MATCH_TERM_CONCEPTS: Record<string, ConditionConcept[]> = {
  "chronic kidney": ["chronic-kidney-disease"],
  hyperkalemia: ["hyperkalemia"],
  hypercalcemia: ["hypercalcemia"],
  wilson: ["wilson-disease"],
};

// Whether ONE condition satisfies a dataset contraindication `match` term —
// its stored CODE first (the concept mapping above), else the lowercased name
// substring the map has always used. THE one matcher for this question, shared
// by the UL caveat (conditionsContraindicatingNutrient), the supplement belt
// (conditionConflict in lib/supplement-safety), and the food engine
// (lib/food-suggest) — so the three surfaces can't disagree about which
// condition contraindicates a nutrient (#657 / "one question, one computation").
export function conditionMatchesTerm(
  term: string,
  condition: ConditionInput
): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return false;
  const concepts = conditionCodeConcepts(condition);
  if (
    concepts.size > 0 &&
    (MATCH_TERM_CONCEPTS[needle] ?? []).some((c) => concepts.has(c))
  ) {
    return true;
  }
  return conditionInputName(condition).toLowerCase().includes(needle);
}

// Active conditions that trigger a drop rule for a given nutrient KEY — the read the
// UL caveat uses (dri keys nutrients the same way the map does). Each hit carries the
// matched condition (display form) and the curated caution. Accepts bare names or
// coded refs (#1030) — a coded-terse row ("CKD stage 3" as N18.30) now triggers.
export function conditionsContraindicatingNutrient(
  nutrientKey: string,
  conditions: readonly ConditionInput[]
): { condition: string; caution: string }[] {
  const out: { condition: string; caution: string }[] = [];
  for (const rule of CONDITION_NUTRIENT_RULES) {
    if (rule.nutrientKey !== nutrientKey) continue;
    for (const c of conditions) {
      if (conditionMatchesTerm(rule.match, c)) {
        out.push({ condition: conditionInputName(c), caution: rule.caution });
      }
    }
  }
  return out;
}
