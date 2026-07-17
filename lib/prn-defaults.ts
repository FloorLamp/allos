// Curated OTC PRN dosing DEFAULTS matcher (issue #798). The single-item lookup twin
// of the food-drug matcher (lib/food-drug-interactions.ts): given ONE intake item
// (its name + cached RxCUI(s)), return the committed OTC label defaults for that
// ingredient — the adult redose interval/max to PRE-FILL, and (for ibuprofen /
// acetaminophen) the label's pediatric weight-band chart. No DB, no network — the facts
// live in the curated-dataset framework (lib/datasets/prn-defaults.ts over the committed,
// hand-maintained, CITED lib/datasets/data/prn-defaults.json).
//
// LIABILITY POSTURE (kept apart, like the food-drug data): everything here is
// INFORMATIONAL. The dataset only PRE-FILLS a suggestion onto the med form that the
// user explicitly confirms/edits; nothing is ever applied silently, and the redose
// notice only ever states facts about the user's OWN confirmed numbers. The pediatric
// bands REPRODUCE the public label chart (no mg/kg computation); age gates are the
// label's own "ask a doctor" refusals. Aspirin has NO pediatric entry (Reye's) — the
// dataset omits it, pinned by lib/__tests__/prn-defaults.test.ts.
//
// Matching mirrors the drug/food datasets: RxCUI is authoritative (an exact match of
// ANY of the item's CUIs — the confirmed product-level rxcui plus its cached active-
// ingredient CUIs, #279 — against an entry's ingredient CUIs); a normalized name/
// synonym match is the fallback (#279's name path). One ingredient per item.

import {
  PRN_DEFAULT_ENTRIES,
  type PrnDefaultEntry,
} from "./datasets/prn-defaults";
import { itemRxcuis } from "./drug-interactions";

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

// The curated OTC defaults for one intake item, or null when the ingredient isn't in
// the dataset. RxCUI is authoritative (exact match of ANY of the item's CUIs against
// an entry's ingredient CUIs); a normalized name/synonym match is the fallback. First
// match wins (an item resolves to at most one ingredient's defaults).
// The redose interval / daily-max to PRE-FILL for a profile from a matched entry
// (issue #851 item 12). For an adult (or unknown age), the adult label figures. For a
// CHILD, the pediatric label figures WHEN the entry carries them (the label differs) —
// otherwise null, a deliberate REFUSAL to prefill the adult numbers for a child (the
// #798 "never guess below the label's floor" posture). `tier` labels the button/badge
// so a prefilled value is always attributed to the right label. Pure.
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

export function prnDefaultsFor(item: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): PrnDefaultEntry | null {
  const cuis = itemRxcuis(item);
  const itemNorm = normalize(item.name);
  for (const e of ENTRIES) {
    const byRxcui = e.rxcuis.some((cui) => cuis.has(cui));
    const byName =
      !byRxcui &&
      e.synonyms.some((syn) => nameContains(itemNorm, normalize(syn)));
    if (byRxcui || byName) return e;
  }
  return null;
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

// Whether an intake item is a fever reducer — the item resolves to an antipyretic
// ingredient in the curated dataset. Reuses prnDefaultsFor's RxCUI-authoritative /
// name-fallback match, so an "Advil"/"Children's Tylenol" row classifies correctly.
export function isAntipyreticIntakeItem(item: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): boolean {
  return isAntipyreticEntry(prnDefaultsFor(item));
}
