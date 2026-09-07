// Label defaults require a complete single-ingredient identity. Ingredient presence
// is a separate question: a combination can reduce fever without sharing the
// single-ingredient product's dosing chart. All suggestions still require confirmation.

import {
  PRN_DEFAULT_ENTRIES,
  type PrnDefaultEntry,
} from "./datasets/prn-defaults";
import { itemRxcuis } from "./drug-interactions";
import { ingredientCuiKey, type MedFamilyItem } from "./medication-family";

type PrnItem = Omit<MedFamilyItem, "id">;

// The item keeps its display name when it links to a shared bottle, but the bottle
// owns what the product is. Project that split once before label matching so every
// live and persisted surface asks the matcher about the same product name.
export function prnLabelIdentityFor(
  item: PrnItem & {
    supplyId: number | string | null;
    supplyName: string | null;
  }
): PrnItem {
  const { supplyId, supplyName, ...identity } = item;
  const linked = supplyId != null && String(supplyId).trim() !== "";
  return {
    ...identity,
    name: supplyName ?? (linked ? "" : identity.name),
  };
}

// Re-export the entry + sub-types from their framework home (lib/datasets/prn-defaults
// .ts) so the existing consumer import paths (`@/lib/prn-defaults`) are unchanged.
export type {
  PrnDefaultEntry,
  PediatricBand,
  PrnFormulation,
  PrnAdultDefaults,
  PrnPediatricDefaults,
} from "./datasets/prn-defaults";

const ENTRIES = PRN_DEFAULT_ENTRIES;

// The full curated dataset (for the dataset test + any catalogue surface).
export function prnDefaultEntries(): readonly PrnDefaultEntry[] {
  return ENTRIES;
}

// Normalize a name/synonym to the matcher's canonical token form: lowercased,
// punctuation collapsed to single spaces. Mirrors the drug/food matchers so the
// committed synonyms line up with a live item name identically across datasets.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whether the normalized synonym appears as a CONTIGUOUS token subsequence of the
// normalized item name — a word-boundary match, so "advil" hits "Advil 200mg" but a
// short token never matches inside an unrelated word.
function nameContains(itemNorm: string, synNorm: string): boolean {
  if (!synNorm) return false;
  return ` ${itemNorm} `.includes(` ${synNorm} `);
}

// Label redose defaults for the selected age tier; no adult fallback for children.
export interface RedoseLabelDefaults {
  minIntervalHours: number;
  maxDailyCount: number;
  tier: "adult" | "pediatric";
  source: string;
}

export function redoseLabelDefaults(
  entry: PrnDefaultEntry,
  isChild: boolean
): RedoseLabelDefaults | null {
  if (isChild) {
    const ped = entry.pediatric;
    if (ped?.minIntervalHours != null && ped?.maxDailyCount != null) {
      return {
        minIntervalHours: ped.minIntervalHours,
        maxDailyCount: ped.maxDailyCount,
        tier: "pediatric",
        source: entry.source,
      };
    }
    return null;
  }
  return {
    minIntervalHours: entry.adult.minIntervalHours,
    maxDailyCount: entry.adult.maxDailyCount,
    tier: "adult",
    source: entry.source,
  };
}

// A resolved ingredient set takes precedence over the display name. Unresolved
// names must match a whole curated synonym; extra wording may name another product.
export function prnDefaultsFor(item: PrnItem): PrnDefaultEntry | null {
  const identity = ingredientCuiKey(item);
  const name = item.name.trim().toLowerCase();
  return (
    ENTRIES.find((entry) =>
      identity
        ? entry.rxcuis.some(
            (cui) => identity === ingredientCuiKey({ rxcui: cui })
          )
        : entry.synonyms.some((synonym) => name === synonym.toLowerCase())
    ) ?? null
  );
}

// The fever-reducing (antipyretic) ingredient slugs in the curated PRN dataset
// (issue #859 item 2, the school-return countdown). Ibuprofen / acetaminophen /
// aspirin / naproxen are antipyretic analgesics; diphenhydramine (an antihistamine)
// is NOT — it does not mask a fever, so it never resets the fever-free clock. There
// is no explicit "antipyretic" field in prn-defaults.json (the #798 dataset predates
// this need), so the class is derived from the curated slug set here — the ONE place
// that judgment lives, so the countdown gather and any future surface agree.
export const ANTIPYRETIC_SLUGS: ReadonlySet<string> = new Set([
  "ibuprofen",
  "acetaminophen",
  "aspirin",
  "naproxen",
]);

// Whether a matched PRN entry is a fever reducer.
export function isAntipyreticEntry(entry: PrnDefaultEntry | null): boolean {
  return entry != null && ANTIPYRETIC_SLUGS.has(entry.slug);
}

// Ingredient presence retains the broader name/CUI match, including combinations.
export function isAntipyreticIntakeItem(item: PrnItem): boolean {
  const cuis = itemRxcuis(item);
  const name = normalize(item.name);
  return ENTRIES.some(
    (entry) =>
      isAntipyreticEntry(entry) &&
      (entry.rxcuis.some((cui) => cuis.has(cui)) ||
        entry.synonyms.some((synonym) =>
          nameContains(name, normalize(synonym))
        ))
  );
}

// Name-only callers use the same ingredient-presence fallback for dose offers.
export function antipyreticPrnMeds<T extends { name: string }>(
  meds: readonly T[]
): T[] {
  return meds.filter((med) =>
    isAntipyreticIntakeItem({
      name: med.name,
      rxcui: null,
      rxcuiIngredients: null,
    })
  );
}
