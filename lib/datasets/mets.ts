// The mets dataset, loaded onto the curated-dataset framework (issue #860 Track B).
//
// This is the FIRST framework-migrated dataset and the reference for the next
// migration (which should be a thin copy of this file's shape): import the envelope
// JSON, validate it once with loadDataset(), build a matcher on the identity
// strategy, and expose small typed accessors. calorie-estimate.ts consumes this
// module instead of reaching into mets.json directly; the registry lists it for the
// linter. Pure — no DB, no network.

import rawMets from "./data/mets.json";
import { loadDataset } from "./loader";
import { createMatcher, nameStrategy } from "./matcher";
import type { MetEntry, MetsMeta } from "@/scripts/gen-mets";

export type { MetEntry, MetsMeta } from "@/scripts/gen-mets";
export type MetTier = "easy" | "moderate" | "hard";

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const metsDataset = loadDataset<MetEntry, MetsMeta>(rawMets);

// Name-keyed matcher (case-insensitive). The refusal gate: an activity not in the
// catalog resolves to null, and the estimator falls back to the per-type default.
const matcher = createMatcher(metsDataset, nameStrategy);

// The MET tiers for a catalog activity NAME, or null when the name isn't curated.
export function metEntryForName(name: string): MetEntry | null {
  return matcher.match(name);
}

// Dataset-level config: the default tier + per-type fallback tiers.
export const metsMeta: MetsMeta = metsDataset.meta as MetsMeta;
