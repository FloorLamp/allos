// Pure helpers for food-habit target findings (issue #580) — the coaching-tier
// observation that a tracked food habit ("fatty fish ≥2×/week") is behind this week.
// The prefix + signal key live here (client-safe, no DB) so lib/rule-finding-prefixes
// can register the namespace and the DB builder (lib/rule-findings) can key its
// findings. Progress itself is getFrequencyTargetProgress (the #579 rollup) — this
// module only owns the finding identity + the behind decision.

import type { FrequencyTargetProgress } from "./queries/training/goals";
import {
  matchFoodInteractions,
  SEVERITY_RANK,
  type Severity,
} from "./food-drug-interactions";
import type { SafetyMedication } from "./supplement-safety";

// The findings-bus namespace for a food-habit-behind observation. Keyed on the food
// group slug (a stable #203 key), so a dismiss follows the habit regardless of which
// day is newest.
export const FOOD_HABIT_PREFIX = "food-habit:";

export function foodHabitSignalKey(groupSlug: string): string {
  return `${FOOD_HABIT_PREFIX}${groupSlug}`;
}

// A food-habit target is "behind" when this week's servings fall short of its target.
// Pure over the shared progress row (no clock) — the coaching finding fires on this.
export function isFoodHabitBehind(p: FrequencyTargetProgress): boolean {
  return p.target.scope_kind === "food_group" && p.count < p.per_week;
}

// ---- Food-group ↔ food–drug interaction screen (issue #661) ----

// Curated food-group slug → food–drug interaction entry keys (lib/food-drug-
// interactions.json). Only groups whose membership IS the interaction's food —
// unambiguous, well-established — are wired, so a habit target inherits the EXACT
// warning the medication's own /medicine row already shows via matchFoodInteractions
// ("one question, one computation": the two surfaces format the same hit). Grapefruit-
// family interactions have no dedicated group (the catalog's closest is the broad
// "fruit"), so they are deliberately LEFT UNMAPPED rather than over-warn every fruit
// habit — exclusion discipline over the food-drug dataset's sourcing standard. The
// anti-drift test pins that every key here resolves to a food-drug entry and every
// slug to a food group.
export const FOOD_GROUP_INTERACTION_KEYS: Record<string, string[]> = {
  // Leafy greens are the canonical vitamin-K food (warfarin consistency).
  leafy_greens: ["vitamin-k-warfarin"],
  // Dairy/calcium chelates several oral drugs (absorption timing).
  dairy: ["dairy-levothyroxine", "dairy-tetracycline", "dairy-fluoroquinolone"],
  // Alcohol interacts with several common drugs.
  alcohol: [
    "alcohol-warfarin",
    "alcohol-metronidazole",
    "alcohol-acetaminophen",
  ],
};

// One food–drug interaction a tracked food-group habit conflicts with, given the
// profile's active medications. Carries the med that matched plus the SAME advice copy
// the /medicine row shows.
export interface FoodHabitInteraction {
  medication: string;
  key: string;
  food: string;
  advice: string;
  severity: Severity;
  source: string;
}

// The food–drug interactions a food-group habit conflicts with for the active stack.
// PURE: reuses matchFoodInteractions (the one matcher the medication surfaces use) and
// keeps only the entries this group participates in, so the habit note can never
// disagree with the medication row. Deduped by entry key, most-severe first. Empty for
// an unmapped group or an empty stack.
export function foodHabitInteractions(
  groupSlug: string,
  medications: readonly SafetyMedication[]
): FoodHabitInteraction[] {
  const keys = FOOD_GROUP_INTERACTION_KEYS[groupSlug];
  if (!keys || keys.length === 0 || medications.length === 0) return [];
  const keySet = new Set(keys);
  const byKey = new Map<string, FoodHabitInteraction>();
  for (const med of medications) {
    for (const hit of matchFoodInteractions({
      name: med.name,
      rxcui: med.rxcui,
      rxcuiIngredients: med.rxcuiIngredients,
    })) {
      if (!keySet.has(hit.key) || byKey.has(hit.key)) continue;
      byKey.set(hit.key, {
        medication: med.name,
        key: hit.key,
        food: hit.food,
        advice: hit.advice,
        severity: hit.severity,
        source: hit.source,
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.key.localeCompare(b.key)
  );
}

// The informational habit-surface note: names the active medication + the shared
// advice line. The SAME advice string the /medicine row renders, so the habits card,
// the "behind this week" coaching finding, and the medication row can't disagree
// (#661). Informational, never blocking the habit.
export function foodHabitInteractionNote(i: FoodHabitInteraction): string {
  return `You take ${i.medication} — ${i.advice}`;
}
