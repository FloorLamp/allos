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

export function foodGroupSlugs(): string[] {
  return FOOD_GROUPS.map((g) => g.slug);
}

// The display name for a slug, falling back to the slug itself for a retired/unknown
// one (the #203 discipline: a logged row under an old slug still renders, never throws).
export function foodGroupName(slug: string): string {
  return foodGroupBySlug(slug)?.name ?? slug;
}
