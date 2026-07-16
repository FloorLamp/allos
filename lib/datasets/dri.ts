// The NIH DRI (UL/RDA) table, loaded onto the curated-dataset framework (issue #860
// Track B). Copies the mets.ts shape: import the envelope JSON, validate it once with
// loadDataset(), build a key-keyed matcher, and expose the nutrient entries for the
// stack-total UL/RDA checker (lib/dri.ts) to consume. The registry lists this dataset
// for the linter. Pure — no DB, no network.

import rawDri from "./data/dri.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";
import type { DriNutrient } from "@/lib/dri";

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const driDataset = loadDataset<DriNutrient>(rawDri);

// Identity strategy: the nutrient `key` field, case-folded.
export const driNutrientStrategy = fieldStrategy("key");

// Key-keyed matcher. The refusal gate: a nutrient key not in the DRI table resolves
// to null.
const matcher = createMatcher(driDataset, driNutrientStrategy);

// The DRI nutrients in curated order — the checker sums the stack per nutrient here.
export const DRI_NUTRIENTS: DriNutrient[] = driDataset.entries;

// The DRI nutrient for a key, or null when the table doesn't cover it.
export function driNutrientForKey(key: string): DriNutrient | null {
  return matcher.match(key);
}
