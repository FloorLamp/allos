// Pure icon-key resolution for food groups (issue #591). Mirrors the
// lib/activity-icon.ts precedent: this maps a food-group SLUG to a stable icon
// KEY; `components/FoodGroupIcon.tsx` maps that key to a Tabler icon component.
// Kept pure and separate from React so the mapping is unit-tested and shared by
// EVERY food surface (the one-tap log bar, the weekly rollup, the habits card,
// the suggestion track buttons) — the glyphs can't drift per surface.
//
// A food group's slug is a stable catalog key (lib/food-groups.json), so unlike
// the activity icon (which keyword-matches free text) this is a direct lookup
// with a generic fallback for a retired/unknown slug (the #203 discipline: an
// old logged slug still renders, never throws).

// Every distinct glyph the food surfaces use — one member per Tabler icon in
// components/FoodGroupIcon.tsx.
export type FoodGroupIconKey =
  | "fish"
  | "leaf"
  | "plant"
  | "carrot"
  | "soup"
  | "seeding"
  | "grain"
  | "apple"
  | "cherry"
  | "bottle"
  | "meat"
  | "egg"
  | "milk"
  | "bowl"
  | "droplet"
  | "sausage"
  | "bread"
  | "burger"
  | "candy"
  | "glass"
  | "cocktail"
  | "generic";

// The generic glyph for an unmapped/retired slug (a plate of cutlery — clearly
// "food" without implying a group).
export const GENERIC_FOOD_ICON_KEY: FoodGroupIconKey = "generic";

// slug → icon key. Tabler has no close glyph for every group (no shrimp, bean,
// potato, or soda), so those fall back to a reasonable generic (a fish for all
// seafood, a bowl for starchy tubers, a full glass for sugary drinks) rather
// than mixing icon sets. Reuse is intentional where the catalog has no finer
// distinction (all three seafood groups share the fish; poultry and red meat
// share the meat).
const SLUG_ICONS: Record<string, FoodGroupIconKey> = {
  // encourage
  fatty_fish: "fish",
  lean_fish: "fish",
  shellfish: "fish",
  leafy_greens: "leaf",
  cruciferous: "plant",
  other_vegetables: "carrot",
  legumes: "soup",
  nuts_seeds: "seeding",
  whole_grains: "grain",
  fruit: "apple",
  berries: "cherry",
  fermented: "bottle",
  // neutral
  poultry: "meat",
  eggs: "egg",
  dairy: "milk",
  red_meat: "meat",
  tubers: "bowl",
  water: "droplet",
  // limit
  processed_meat: "sausage",
  refined_grains: "bread",
  fried_food: "burger",
  added_sugar: "candy",
  sugary_drinks: "glass",
  alcohol: "cocktail",
};

/**
 * Resolve the icon key for a food-group slug. Falls back to the generic food
 * glyph for a retired/unknown slug so history always renders.
 */
export function foodGroupIconKey(slug: string): FoodGroupIconKey {
  return SLUG_ICONS[slug] ?? GENERIC_FOOD_ICON_KEY;
}
