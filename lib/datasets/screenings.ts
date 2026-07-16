// The USPSTF preventive-screening catalog, loaded onto the curated-dataset framework
// (issue #860 Track B). Copies the mets.ts shape: import the envelope JSON, validate
// it once with loadDataset(), build a key-keyed matcher, and expose the screening rows
// + the dataset-level `reviewed` date for lib/preventive-catalog.ts to reconstruct its
// typed ScreeningRules. The registry lists this dataset for the linter. Pure — no DB,
// no network.

import rawScreenings from "./data/screenings.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";
import type { ScreeningRow, ScreeningsMeta } from "@/scripts/gen-screenings";

export type { ScreeningRow, ScreeningsMeta } from "@/scripts/gen-screenings";

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const screeningsDataset = loadDataset<ScreeningRow, ScreeningsMeta>(
  rawScreenings
);

// Identity strategy: the screening `key` field, case-folded.
export const screeningKeyStrategy = fieldStrategy("key");

// Key-keyed matcher. The refusal gate: a screening key not in the catalog resolves
// to null.
const matcher = createMatcher(screeningsDataset, screeningKeyStrategy);

// The screening rows in catalog order — preventive-catalog reconstructs typed rules
// from these.
export const SCREENING_ROWS: ScreeningRow[] = screeningsDataset.entries;

// The month the dataset was last reviewed against USPSTF (dataset-level metadata).
export const SCREENINGS_REVIEWED: string = (
  screeningsDataset.meta as ScreeningsMeta
).reviewed;

// The screening row for a key, or null when the catalog doesn't cover it.
export function screeningForKey(key: string): ScreeningRow | null {
  return matcher.match(key);
}
