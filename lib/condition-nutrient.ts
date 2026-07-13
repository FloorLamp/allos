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

import mapData from "./nutrient-food-map.json";
import type { NutrientFoodMap } from "@/scripts/gen-nutrient-food-map";

const ENTRIES = (mapData as NutrientFoodMap).entries;

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

// Active conditions that trigger a drop rule for a given nutrient KEY — the read the
// UL caveat uses (dri keys nutrients the same way the map does). Each hit carries the
// matched condition (display form) and the curated caution.
export function conditionsContraindicatingNutrient(
  nutrientKey: string,
  conditions: readonly string[]
): { condition: string; caution: string }[] {
  const out: { condition: string; caution: string }[] = [];
  for (const rule of CONDITION_NUTRIENT_RULES) {
    if (rule.nutrientKey !== nutrientKey) continue;
    for (const c of conditions) {
      if ((c ?? "").toLowerCase().includes(rule.match)) {
        out.push({ condition: c, caution: rule.caution });
      }
    }
  }
  return out;
}
