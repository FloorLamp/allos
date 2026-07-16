// The ICD-10-CM common-conditions map, loaded onto the curated-dataset framework
// (issue #860 Track B). Copies the mets.ts shape: import the envelope JSON, validate
// it once with loadDataset(), build a code-keyed matcher, and expose the entries for
// the suggestion engine (lib/icd10.ts) to consume. The registry lists this dataset for
// the linter. Pure — no DB, no network.

import rawIcd10 from "./data/icd10-common.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";
import type { Icd10CuratedEntry, Icd10Meta } from "@/scripts/gen-icd10";

export type { Icd10CuratedEntry, Icd10Meta } from "@/scripts/gen-icd10";

// The validated dataset (envelope + guarantees). Throws at module load if the
// committed JSON ever violates the contract — a loud, early failure.
export const icd10Dataset = loadDataset<Icd10CuratedEntry, Icd10Meta>(rawIcd10);

// Identity strategy: the ICD-10-CM `code` field, case-folded (codes compare
// case-insensitively — hasIcd10Code upper-cases; the matcher lower-cases; both fold).
export const icd10CodeStrategy = fieldStrategy("code");

// Code-keyed matcher. The refusal gate: a code not in the curated subset resolves to
// null (never a nearest-neighbour guess).
const matcher = createMatcher(icd10Dataset, icd10CodeStrategy);

// The curated conditions in code-sorted order — the suggestion engine ranks over this.
export const ICD10_CONDITIONS: Icd10CuratedEntry[] = icd10Dataset.entries;

// The curated entry for an exact ICD-10-CM code (case-insensitive), or null.
export function icd10EntryForCode(code: string): Icd10CuratedEntry | null {
  return matcher.match(code);
}
