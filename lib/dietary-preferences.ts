// Dietary preferences (issue #975) — a per-profile EXCLUDED food-group set over the 24
// catalog slugs, plus labeled PRESETS that pre-fill it (vegetarian/vegan/pescatarian/…).
// Pure — no DB/network/clock: the stored truth is the excluded set (a settings-tier JSON
// value, lib/settings/profile-attrs.ts); the preset "name" is DERIVED from the set here
// (presetForExcluded), so editing after picking a preset just customizes the set and the
// label drops to "custom" the moment it diverges. There is no pattern engine — one filter.
//
// These are PREFERENCES, a softer layer than the #577 allergy/medication SAFETY gates:
// they only reorder/substitute suggestions and demote the one-tap bar — logging is NEVER
// blocked, and no preference ever changes a computed intake (protein/fiber floors sum what
// was LOGGED, never what's preferred). Deliberately NOT presets (recorded in #975 so they
// aren't "helpfully" added): halal/kosher (the catalog can't express pork — folded into
// red_meat/processed_meat) and gluten-free (whole_grains includes rice/oats; it's the
// allergy side's jurisdiction). Users compose those from the open multi-select.

import { canonicalFoodGroup, foodGroupSlugs } from "./food-groups";

export type DietaryPreset =
  | "omnivore"
  | "vegetarian"
  | "vegan"
  | "pescatarian"
  | "no_red_meat"
  | "dairy_free"
  | "keto";

// The decided preset table (#975 §Preset list). Each preset is a labeled pre-fill of the
// excluded set; Omnivore excludes nothing (the default). Berries are DELIBERATELY kept out
// of keto's exclusions — the standard keto allowance and the best low-carb nutrient
// source. Pinned exactly by lib/__tests__/dietary-preferences.test.ts.
const PRESET_EXCLUSIONS: Record<DietaryPreset, string[]> = {
  omnivore: [],
  vegetarian: [
    "fatty_fish",
    "lean_fish",
    "shellfish",
    "poultry",
    "red_meat",
    "processed_meat",
  ],
  vegan: [
    "fatty_fish",
    "lean_fish",
    "shellfish",
    "poultry",
    "red_meat",
    "processed_meat",
    "eggs",
    "dairy",
  ],
  pescatarian: ["poultry", "red_meat", "processed_meat"],
  no_red_meat: ["red_meat", "processed_meat"],
  dairy_free: ["dairy"],
  keto: [
    "whole_grains",
    "refined_grains",
    "tubers",
    "legumes",
    "fruit",
    "added_sugar",
    "sugary_drinks",
  ],
};

// Human labels for the preset picker (#945 sentence case; the two-name pattern is a
// proper noun for a dietary pattern).
export const DIETARY_PRESET_LABELS: Record<DietaryPreset, string> = {
  omnivore: "Omnivore",
  vegetarian: "Vegetarian",
  vegan: "Vegan",
  pescatarian: "Pescatarian",
  no_red_meat: "No red meat",
  dairy_free: "Dairy-free",
  keto: "Keto",
};

// The preset picker's order (Omnivore first — the default).
export const DIETARY_PRESETS: DietaryPreset[] = [
  "omnivore",
  "vegetarian",
  "vegan",
  "pescatarian",
  "no_red_meat",
  "dairy_free",
  "keto",
];

// The excluded slug set a preset pre-fills, as a fresh sorted array (canonical order).
export function expandPreset(preset: DietaryPreset): string[] {
  return [...PRESET_EXCLUSIONS[preset]].sort();
}

// Normalize an arbitrary excluded-group input to the CANONICAL, de-duplicated, sorted set
// of catalog slugs — dropping anything that doesn't resolve to a real food group (#883:
// only a catalog `.slug` is ever stored/compared). The one gate every write path runs.
export function normalizeExcludedGroups(raw: readonly string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const slug = canonicalFoodGroup(r);
    if (slug) out.add(slug);
  }
  return [...out].sort();
}

// The preset a normalized excluded set corresponds to, or "custom" when it matches none.
// The DERIVED label: pick a preset, and the set matches it → its name; edit one slug → the
// set diverges → "custom". Compares canonical sorted sets for exact equality. An empty set
// is Omnivore.
export function presetForExcluded(
  excluded: readonly string[]
): DietaryPreset | "custom" {
  const norm = normalizeExcludedGroups(excluded);
  const key = norm.join(",");
  for (const preset of DIETARY_PRESETS) {
    if (expandPreset(preset).join(",") === key) return preset;
  }
  return "custom";
}

// Whether a food group slug is excluded by the preference set. A null/unknown group is
// never excluded (untracked foods carry no preference).
export function isExcludedGroup(
  slug: string | null | undefined,
  excluded: ReadonlySet<string>
): boolean {
  return slug != null && excluded.has(slug);
}

// ---- Consumption rule 1: SUBSTITUTE in suggestions (never an empty suggestion) ----

// A minimal food shape the preference filter operates over (the #577 SuggestedFood and the
// #774 FoodSource both satisfy it — a display food carrying its catalog `foodGroup` slug).
export interface PreferenceFilterable {
  foodGroup: string | null;
}

// Filter a ranked list of food sources to the preference-COMPATIBLE ones — but SUBSTITUTE,
// never silently drop the shortfall: if excluding leaves at least one compatible source,
// return those (the excluded top source is skipped, the next compatible one leads); if
// EVERY source is excluded, return the original list unchanged (a nutrient shortfall must
// never disappear because its only sources are excluded — #975 §3.1). Preserves input
// order. Pure.
export function applyPreferenceFilter<T extends PreferenceFilterable>(
  foods: readonly T[],
  excluded: ReadonlySet<string>
): T[] {
  if (excluded.size === 0) return [...foods];
  const compatible = foods.filter(
    (f) => !isExcludedGroup(f.foodGroup, excluded)
  );
  return compatible.length > 0 ? compatible : [...foods];
}

// ---- Consumption rule 2: DEMOTE (never block) in the one-tap bar + nudge ranking ----

// Push excluded groups to the TAIL of a ranked slug order while keeping them reachable
// (#975 §3.2 — you can always log what you actually ate). A STABLE partition: non-excluded
// slugs keep their (slot-frecency, #950) order, then the excluded ones in their original
// order. Applied AFTER the frecency blend, so preference demotion composes with slot
// ranking rather than replacing it. Pure.
export function demoteExcludedGroups(
  rankedSlugs: readonly string[],
  excluded: ReadonlySet<string>
): string[] {
  if (excluded.size === 0) return [...rankedSlugs];
  const kept: string[] = [];
  const demoted: string[] = [];
  for (const slug of rankedSlugs) {
    if (excluded.has(slug)) demoted.push(slug);
    else kept.push(slug);
  }
  return [...kept, ...demoted];
}

// The full catalog slug set (for validating a multi-select in the UI/action). Re-exported
// convenience so callers don't reach into food-groups for the same list.
export function allFoodGroupSlugs(): string[] {
  return foodGroupSlugs();
}

// ---- Legibility: the "why did this suggestion change?" note (#980 item 4) ----------

// The muted note the Food-tab suggestions summary shows when a preference is filtering the
// food sources — the verbal twin of the #950 slot chip: "showing vegetarian-friendly
// sources" makes the demote/substitute explicable on-surface. Per-preset copy so each
// reads naturally (#945); a "No red meat" / "Dairy-free" preset states the exclusion
// rather than forcing an awkward "-friendly". Pure — the DERIVED preset drives it.
const PREFERENCE_SUGGESTION_NOTE: Record<DietaryPreset, string | null> = {
  omnivore: null,
  vegetarian: "showing vegetarian-friendly sources",
  vegan: "showing vegan-friendly sources",
  pescatarian: "showing pescatarian-friendly sources",
  no_red_meat: "showing sources without red meat",
  dairy_free: "showing dairy-free sources",
  keto: "showing keto-friendly sources",
};

// The note text for a profile's excluded set, or null when NO preference is set (an empty
// set is Omnivore — no filtering happens, so no note renders, per #980's "no empty chrome"
// on an unset preference). A custom set (matching no named preset) gets a neutral note.
export function preferenceSuggestionNote(
  excluded: readonly string[]
): string | null {
  const norm = normalizeExcludedGroups(excluded);
  if (norm.length === 0) return null;
  const preset = presetForExcluded(norm);
  if (preset === "custom") return "showing sources that fit your preferences";
  return PREFERENCE_SUGGESTION_NOTE[preset];
}
