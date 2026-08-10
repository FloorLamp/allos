// "What ONE food would close yesterday's protein or fibre gap?" — issue #2383, pure: no
// DB, no clock, no network.
//
// THIS IS NOT AN ENGINE. lib/food-suggest.ts (#577) already turns a nutrient shortfall
// into safety-screened, curated food sources; it only ever took a FLAGGED BIOMARKER as
// its input. #2383 gives it a second input — the resolved protein/fibre adequacy verdict
// the digest already reports (#2379/#2405) — and this module is the adapter: it names the
// curated entries, hands the engine the shortfall as a `TargetTrigger`, and reduces the
// screened result to the ONE thing a digest line has room for. Not one threshold, not one
// safety screen and not one food lives here.
//
// FOUR DECISIONS, and they are the whole module:
//
//   1. WHICH shortfall, when both nutrients missed. By RELATIVE gap — the shortfall as a
//      fraction of its own target — not by grams. 20 g of a 38 g fibre target and 20 g of
//      a 130 g protein target are not the same miss, and grams would always hand the
//      suggestion to whichever nutrient happens to be counted in bigger numbers. Ties fall
//      back to the declared NUTRIENT_KEYS order.
//
//   2. WHICH food, once the engine has screened them. The first surviving source whose
//      curated `foodGroup` is a slug in the food-group catalog AND actually carries the
//      short nutrient (a positive `protein_g` / `fiber_g` on that group). Both halves are
//      load-bearing: the first is what makes the suggestion offerable — the one-tap food
//      bar is built from that catalog, so a group in it is a group the bar can log — and
//      the second is what makes it HONEST, since a group the catalog scores at no protein
//      cannot move the number the line just reported.
//
//   3. WHEN NOT TO COMPRESS. A one-line suggestion has room for a food and nothing else,
//      so a screened suggestion still carrying a condition, medication or biomarker
//      CAUTION is not offered here at all. Those notes exist because #577 refuses to drop
//      them silently, and squeezing the food out while leaving the caveat behind is
//      exactly that silent drop. An allergy or preference note is different in kind: it
//      reports that the UNSAFE sources were already removed, so what is left is safe to
//      name on its own. The full screened suggestion, notes included, is unchanged and
//      still available to any surface with room for it.
//
//   4. WHEN TO SAY NOTHING AT ALL. Three cases, all of them silence, all of them
//      inherited rather than re-derived here: no shortfall reaches this module for a met
//      target, for an unresolved target, or for a day with nothing logged — `getNutritionDay`
//      returns no position and `nutritionShortfalls` returns []. A day with no food logged
//      is a day we know NOTHING about, not a day of zero protein, and it must never
//      produce a suggestion. The one case this module adds is a `below` whose gap ROUNDS
//      to zero: the line may still state the figures, but there is nothing to close.
//
// Curated only, by construction: every food surfaced here came out of
// lib/datasets/data/nutrient-food-map.json through the engine. There is no generation
// path and no fallback food.

import { foodGroupBySlug, foodGroupName } from "./food-groups";
import {
  suggestFoods,
  type FoodSafetyNoteKind,
  type FoodSuggestInput,
  type FoodSuggestion,
} from "./food-suggest";
import {
  NUTRIENT_LABELS,
  nutrientPositionPhrase,
  type NutrientKey,
  type NutrientPosition,
} from "./nutrition-day";

// The curated map entry that answers each modelled nutrient. Declared rather than assumed
// equal to the nutrient key (the DRI_KEY_TO_MAP_KEY precedent): the two vocabularies are
// owned by different datasets and only happen to agree today.
export const NUTRIENT_FOOD_MAP_KEYS: Record<NutrientKey, string> = {
  protein: "protein",
  fiber: "fiber",
};

// The profile safety facts the screens need — the SAME gather the biomarker route uses,
// minus the two trigger fields this module supplies itself. Typed off the engine's own
// input so a new screen cannot be added there and silently skipped here.
export type NutritionSafetyContext = Omit<
  FoodSuggestInput,
  "flagged" | "targets"
>;

// The one curated food group offered against one shortfall.
export interface ShortfallFoodSuggestion {
  // Which nutrient it addresses.
  nutrient: NutrientKey;
  // The curated map entry it came from (`food-suggest:<key>` is that entry's dedupe family).
  key: string;
  // The food-group slug — in the catalog the one-tap bar is built from, by construction.
  foodGroup: string;
  // The catalog's own display name for that group, so the words match the bar's row.
  groupName: string;
  // The curated source's display label, in the map's own wording.
  food: string;
  // Grams of the SHORT nutrient one catalog serving of the group carries. Positive by
  // construction — see decision 2.
  gramsPerServing: number;
  // True when the engine surfaced this as the allergy/preference ALTERNATIVE rather than a
  // primary source. Carried because a surface with room for it should say so.
  isAlternative: boolean;
}

// Safety notes that a one-line offer cannot carry, and therefore must not outrun. See
// decision 3 in the header.
const UNCOMPRESSIBLE_NOTES: readonly FoodSafetyNoteKind[] = [
  "condition",
  "medication",
  "biomarker",
];

function carriesCaveat(suggestion: FoodSuggestion): boolean {
  return suggestion.safetyNotes.some((n) =>
    UNCOMPRESSIBLE_NOTES.includes(n.kind)
  );
}

// Grams of `nutrient` in one catalog serving of `slug`, or null when the group is not in
// the catalog or is not scored as a source of it.
function servingGrams(nutrient: NutrientKey, slug: string): number | null {
  const group = foodGroupBySlug(slug);
  if (!group) return null;
  const grams = nutrient === "protein" ? group.protein_g : group.fiber_g;
  return grams != null && grams > 0 ? grams : null;
}

// The miss as a fraction of the target it was measured against — the comparable quantity
// across two nutrients counted in different numbers.
function relativeGap(p: NutrientPosition): number {
  return p.targetGrams > 0 ? p.shortfallGrams / p.targetGrams : 0;
}

// THE ENTRY POINT: the shortfalls `nutritionShortfalls` already resolved, plus the
// profile's safety facts, → the ONE curated food group to offer, or null.
//
// Null is the common answer and every route to it is deliberate: nothing was short, the
// gap rounds to zero, the curated entry was withheld by a drop-severity contraindication,
// every source was struck with no safe alternative, the surviving suggestion still carries
// a caveat this surface cannot print, or no surviving source maps onto a catalog group
// that actually carries the nutrient.
export function shortfallFoodSuggestion(
  shortfalls: readonly NutrientPosition[],
  safety: NutritionSafetyContext
): ShortfallFoodSuggestion | null {
  const real = shortfalls.filter((s) => s.shortfallGrams > 0);
  if (real.length === 0) return null;

  // ONE engine call for every short nutrient — the screens are per-profile, so asking
  // twice would only pay for the same allergy/medication/condition work again.
  const screened = suggestFoods({
    ...safety,
    flagged: [],
    targets: real.map((s) => ({
      key: NUTRIENT_FOOD_MAP_KEYS[s.nutrient],
      direction: "add" as const,
      // The figure the digest line is already stating, so the suggestion's own reason and
      // the line it rides cannot disagree about the day (#221).
      reason: nutrientPositionPhrase(s),
    })),
  });
  const byKey = new Map(screened.map((s) => [s.key, s]));

  // Biggest relative miss first; `sort` is stable, so an exact tie keeps the declared
  // nutrient order `nutritionShortfalls` handed us.
  const ranked = [...real].sort((a, b) => relativeGap(b) - relativeGap(a));

  for (const position of ranked) {
    const key = NUTRIENT_FOOD_MAP_KEYS[position.nutrient];
    const suggestion = byKey.get(key);
    if (!suggestion || carriesCaveat(suggestion)) continue;
    for (const food of suggestion.foods) {
      if (!food.foodGroup) continue;
      const gramsPerServing = servingGrams(position.nutrient, food.foodGroup);
      if (gramsPerServing == null) continue;
      return {
        nutrient: position.nutrient,
        key,
        foodGroup: food.foodGroup,
        groupName: foodGroupName(food.foodGroup),
        food: food.food,
        gramsPerServing,
        isAlternative: food.isAlternative,
      };
    }
  }
  return null;
}

// The digest's wording for it: one NOTE fragment on the existing nutrition line.
//
// IT NAMES THE CATALOG GROUP, not the curated food's prose label, because the group name
// is the words on the row the reader will tap — "Legumes & beans", not "Legumes, beans,
// and chickpeas". The per-serving figure is what turns a name into a reason: it says how
// much of the gap the line just reported one tap actually closes.
//
// "try" and not "eat": adequacy is an OBSERVATION, not an obligation (#992). An offer the
// reader can decline reads differently from an instruction, and this line has no
// escalation, no streak and no follow-up behind it.
export function shortfallFoodPhrase(s: ShortfallFoodSuggestion): string {
  return `try ${s.groupName.toLowerCase()} (${s.gramsPerServing} g ${NUTRIENT_LABELS[s.nutrient]} a serving)`;
}
