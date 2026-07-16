// Plain-language biomarker descriptions, loaded onto the curated-dataset framework
// (issue #860 Track B). Copies the mets.ts shape: import the envelope JSON, validate
// it once with loadDataset(), build a name-keyed matcher, and expose the entries for
// lib/biomarker-info.ts to index. This dataset was hand-authored (no generator), so it
// simply moved under lib/datasets/data/ as an envelope; the coverage test
// (lib/__tests__/biomarker-descriptions.test.ts) remains its anti-drift guard. The
// registry lists it for the linter. Pure — no DB, no network.

import rawDescriptions from "./data/biomarker-descriptions.json";
import { loadDataset } from "./loader";
import { createMatcher, nameStrategy } from "./matcher";

// One educational description entry, identity-keyed by canonical biomarker `name`.
export interface BiomarkerDescriptionEntry {
  name: string;
  abbreviation?: string;
  full_name: string;
  description: string;
}

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const biomarkerDescriptionsDataset =
  loadDataset<BiomarkerDescriptionEntry>(rawDescriptions);

// Name-keyed matcher (case-insensitive). The refusal gate: a biomarker with no
// curated description resolves to null.
const matcher = createMatcher(biomarkerDescriptionsDataset, nameStrategy);

// The description entries in file order.
export const BIOMARKER_DESCRIPTION_ENTRIES: BiomarkerDescriptionEntry[] =
  biomarkerDescriptionsDataset.entries;

// The description entry for a canonical biomarker name (case-insensitive), or null.
export function biomarkerDescriptionForName(
  name: string
): BiomarkerDescriptionEntry | null {
  return matcher.match(name);
}
