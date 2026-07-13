// Pure helpers for food-habit target findings (issue #580) — the coaching-tier
// observation that a tracked food habit ("fatty fish ≥2×/week") is behind this week.
// The prefix + signal key live here (client-safe, no DB) so lib/rule-finding-prefixes
// can register the namespace and the DB builder (lib/rule-findings) can key its
// findings. Progress itself is getFrequencyTargetProgress (the #579 rollup) — this
// module only owns the finding identity + the behind decision.

import type { FrequencyTargetProgress } from "./queries/training/goals";

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
