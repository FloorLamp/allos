// The biomarker→supplement map, on the curated-dataset framework (issue #2378). Copies
// the nutrient-food-map.ts shape exactly — import the envelope JSON, validate it once
// with loadDataset(), build a key-keyed matcher, expose the entries for the pure engine
// (lib/supplement-suggest-curated.ts) to consume. The registry lists this dataset for
// the linter. Pure — no DB, no network.

import rawMap from "./data/biomarker-supplement-map.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";
import type {
  BiomarkerSupplementEntry,
  SupplementSource,
} from "@/scripts/gen-biomarker-supplement-map";

export type {
  BiomarkerSupplementEntry,
  SupplementSource,
} from "@/scripts/gen-biomarker-supplement-map";

// The validated dataset (envelope + guarantees). Throws at module load if the committed
// JSON ever violates the contract — a loud, early failure.
export const biomarkerSupplementMapDataset =
  loadDataset<BiomarkerSupplementEntry>(rawMap);

// Identity strategy: the nutrient `key` field, case-folded.
export const supplementMapKeyStrategy = fieldStrategy("key");

// Key-keyed matcher. The refusal gate: a key not in the map resolves to null — which
// is exactly the "fall through to the AI route" case (#2378), never a guess.
const matcher = createMatcher(
  biomarkerSupplementMapDataset,
  supplementMapKeyStrategy
);

// A map entry as the shared curated-suggestion engine reads it (lib/curated-suggest.ts,
// #5173): the engine names every entry's candidate list `items`, this map spells it
// `supplements`. Named ONCE here — the committed JSON is untouched.
export type BiomarkerSupplementMapEntry = BiomarkerSupplementEntry & {
  readonly items: SupplementSource[];
};

export const BIOMARKER_SUPPLEMENT_ENTRIES: BiomarkerSupplementMapEntry[] =
  biomarkerSupplementMapDataset.entries.map((e) => ({
    ...e,
    items: e.supplements,
  }));

// The map entry for a nutrient key, or null when the map doesn't cover it.
export function biomarkerSupplementEntryForKey(
  key: string
): BiomarkerSupplementEntry | null {
  return matcher.match(key);
}
