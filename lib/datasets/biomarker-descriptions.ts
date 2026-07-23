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
import { buildCanonicalIndex, snapCanonicalName } from "../canonical-name";

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

// The display shape pages consume (the entry minus its identity `name`).
export interface BiomarkerInfo {
  // Short abbreviation (e.g. "RDW"), when the marker has a well-known one.
  abbreviation?: string;
  // Human-readable expansion of the name (e.g. "Red Cell Distribution Width").
  full_name: string;
  // 1-3 plain-language sentences: what it measures and why it generally matters.
  description: string;
}

// The description names ARE the canonical biomarker names, so an alias index over
// them lets a bare abbreviation / legacy spelling resolve the same way the import
// path does — e.g. "RDW" → "Red Cell Distribution Width (RDW)". Built once at load.
const NAME_INDEX = buildCanonicalIndex(
  BIOMARKER_DESCRIPTION_ENTRIES.map((e) => e.name)
);

// The educational description for a canonical biomarker name, or null when none is
// curated. The framework matcher already handles the exact/case-insensitive match;
// on a miss the name is snapped through the canonical alias index so an abbreviation
// or legacy spelling still resolves (the exact-match hazard the flag/derive paths
// share). Returns the display shape (drops the identity `name`).
export function getBiomarkerInfo(
  canonicalName: string | null | undefined
): BiomarkerInfo | null {
  if (!canonicalName) return null;
  const trimmed = canonicalName.trim();
  const entry =
    matcher.match(trimmed) ??
    matcher.match(snapCanonicalName(trimmed, NAME_INDEX));
  if (!entry) return null;
  const { abbreviation, full_name, description } = entry;
  return abbreviation !== undefined
    ? { abbreviation, full_name, description }
    : { full_name, description };
}
