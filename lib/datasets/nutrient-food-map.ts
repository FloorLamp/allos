// The biomarker→nutrient→food map, loaded onto the curated-dataset framework (issue
// #860 Track B). Copies the mets.ts shape: import the envelope JSON, validate it once
// with loadDataset(), build a key-keyed matcher, and expose the low `entries` + the
// high-side `meta.reduceEntries` for the food-suggestion engines (lib/food-suggest.ts,
// lib/condition-nutrient.ts) to consume. The registry lists this dataset for the
// linter. Pure — no DB, no network.

import rawMap from "./data/nutrient-food-map.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";
import type {
  FoodSource,
  NutrientFoodEntry,
  ReduceFoodEntry,
  NutrientFoodMapMeta,
} from "@/scripts/gen-nutrient-food-map";

export type {
  NutrientFoodEntry,
  ReduceFoodEntry,
  NutrientFoodMapMeta,
} from "@/scripts/gen-nutrient-food-map";

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const nutrientFoodMapDataset = loadDataset<
  NutrientFoodEntry,
  NutrientFoodMapMeta
>(rawMap);

// Identity strategy: the nutrient `key` field, case-folded.
export const nutrientKeyStrategy = fieldStrategy("key");

// Key-keyed matcher over the low (ADD) entries. The refusal gate: a nutrient key not
// in the map resolves to null.
const matcher = createMatcher(nutrientFoodMapDataset, nutrientKeyStrategy);

// A map entry as the shared curated-suggestion engine reads it (lib/curated-suggest.ts,
// #5173): the engine names every entry's candidate list `items`, this map spells it
// `foods`. Named ONCE here — the committed JSON is untouched, and `foods` stays for the
// consumers that read the food-shaped field by its own name.
export type NutrientFoodMapEntry = NutrientFoodEntry & {
  readonly items: FoodSource[];
};

// The low-direction entries (ADD a food when a biomarker family reads low, #577).
export const NUTRIENT_FOOD_ENTRIES: NutrientFoodMapEntry[] =
  nutrientFoodMapDataset.entries.map((e) => ({ ...e, items: e.foods }));

// The high-side REDUCE entries (limit a food when a biomarker reads high, #775),
// carried in dataset meta.
export const REDUCE_FOOD_ENTRIES: ReduceFoodEntry[] = (
  nutrientFoodMapDataset.meta as NutrientFoodMapMeta
).reduceEntries;

// The low-direction map entry for a nutrient key, or null when the map doesn't cover it.
export function nutrientFoodEntryForKey(key: string): NutrientFoodEntry | null {
  return matcher.match(key);
}
