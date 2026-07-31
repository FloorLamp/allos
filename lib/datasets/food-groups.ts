// The food-group catalog, loaded onto the curated-dataset framework (issue #860
// Track B). Copies the mets.ts shape: import the envelope JSON, validate it once with
// loadDataset(), build a slug-keyed matcher, and expose small typed accessors. The
// public lib/food-groups.ts re-exports these so every existing `@/lib/food-groups`
// importer is unchanged; the registry lists this dataset for the linter. Pure — no
// DB, no network.

import rawFoodGroups from "./data/food-groups.json";
import { loadDataset } from "./loader";
import { createMatcher, slugStrategy } from "./matcher";
import type { FoodGroup, FoodGroupTier } from "@/scripts/gen-food-groups";

export type { FoodGroup, FoodGroupTier };

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const foodGroupsDataset = loadDataset<FoodGroup>(rawFoodGroups);

// Slug-keyed matcher. The refusal gate: a slug not in the catalog resolves to null.
const matcher = createMatcher(foodGroupsDataset, slugStrategy);

// The catalog in file order (encourage-first). Callers iterate this for the log bar,
// rollup, habit targets, etc.
export const FOOD_GROUPS: FoodGroup[] = foodGroupsDataset.entries;

// The group for a slug, or undefined for a retired/unknown one (behavior-identical to
// the old Map lookup — null from the matcher is normalized to undefined).
export function foodGroupBySlug(slug: string): FoodGroup | undefined {
  return matcher.match(slug) ?? undefined;
}

export function isValidFoodGroup(slug: string): boolean {
  return matcher.has(slug);
}

// The canonical catalog slug for a raw input, or null for a retired/unknown group.
// PERSIST THIS, never the raw input (#883): the matcher's normalized/fuzzy match exists
// to FIND an entry ("Leafy_Greens"/"leafy-greens" both resolve), but every downstream
// reader compares the stored `group_key`/`scope_value` EXACTLY against the canonical
// slug — so a write that lands the raw variant becomes silently invisible to daily
// totals, habit progress, and interaction checks. Boundary write paths canonicalize
// through here so only a catalog `.slug` is ever stored.
export function canonicalFoodGroup(raw: string): string | null {
  return matcher.match(raw)?.slug ?? null;
}

export function foodGroupSlugs(): string[] {
  return FOOD_GROUPS.map((g) => g.slug);
}

// The display name for a slug, falling back to the slug itself for a retired/unknown
// one (the #203 discipline: a logged row under an old slug still renders, never throws).
export function foodGroupName(slug: string): string {
  return foodGroupBySlug(slug)?.name ?? slug;
}

// ---- One emoji per group (issue #1710) ----
//
// The 3×2 Telegram button grid and the tally line were a wall of same-weight words; a
// glyph per group is what makes them scannable at a glance. ONE catalog (#221), used by
// the Telegram nudge (buttons AND tally) and the web food bar alike, so the two surfaces
// speak one vocabulary.
//
// Chosen to be unambiguous at small size and to avoid near-duplicates across the full
// set; `datasets-food-groups.test.ts` pins that every catalog slug has exactly one entry
// and that no two groups share a glyph.
const FOOD_GROUP_EMOJI: Readonly<Record<string, string>> = {
  fatty_fish: "🐟",
  lean_fish: "🐠",
  shellfish: "🦐",
  leafy_greens: "🥬",
  cruciferous: "🥦",
  other_vegetables: "🥕",
  legumes: "🫘",
  nuts_seeds: "🥜",
  whole_grains: "🌾",
  fruit: "🍎",
  berries: "🫐",
  fermented: "🥒",
  poultry: "🍗",
  eggs: "🥚",
  dairy: "🧀",
  red_meat: "🥩",
  tubers: "🥔",
  water: "💧",
  processed_meat: "🌭",
  refined_grains: "🍞",
  fried_food: "🍟",
  added_sugar: "🍬",
  sugary_drinks: "🥤",
  alcohol: "🍷",
};

// The glyph for a slug, or "" for a retired/unknown one — the same refusal posture as
// foodGroupBySlug, so a missing emoji degrades to no emoji rather than a placeholder.
export function foodGroupEmoji(slug: string): string {
  const canonical = matcher.match(slug)?.slug ?? slug;
  return FOOD_GROUP_EMOJI[canonical] ?? "";
}

// The catalog map itself, for the reflection test and any surface iterating groups.
export { FOOD_GROUP_EMOJI };
