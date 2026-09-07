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
// Ingredient presence supports fever classification, but a product label applies only
// to a single-ingredient product. Keep those questions separate: combination products
// retain their ingredient identity without inheriting one ingredient's dose chart.

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

interface PrnItem {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
  ingredients?: readonly { name: string }[];
}

function ingredientEntryFor(item: PrnItem): PrnDefaultEntry | null {
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

// A name-only label match must explain the whole product name. Strip only ordinary
// age, strength and dosage-form descriptors, never arbitrary words after a strength:
// "acetaminophen 300 mg / codeine 30 mg" still names a second ingredient. Unknown
// qualifiers (including combination brands) refuse; a package label or pharmacist
// can supply a dose where this small curated dataset cannot.
function isPlainProductName(name: string, entry: PrnDefaultEntry): boolean {
  // Unlike ingredient presence matching, refusal must retain unknown letters in
  // every script; dropping them would erase a second ingredient from the name.
  let remaining = name
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml)\b/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
  for (const synonym of [...entry.synonyms].sort(
    (a, b) => b.length - a.length
  )) {
    remaining = remaining.replace(
      new RegExp(`\\b${normalize(synonym)}\\b`, "g"),
      " "
    );
  }
  return (
    remaining
      .replace(
        /\b(?:children s|childrens|infant s|infants|junior|extra strength|regular strength|oral|suspension|drops|liquid|tablets?|caplets?|capsules?|chewable|gelcaps?)\b/g,
        " "
      )
      .trim() === ""
  );
}

// Before a picker simplifies a product name to a known generic, preserve any
// qualifiers the generic's dosing label cannot explain. This asks only about the
// name; it does not resolve or manufacture confirmed RxNorm identity.
export function preservesPrnProductName(
  name: string,
  generic: string
): boolean {
  const entry = ingredientEntryFor({ name: generic, rxcui: null });
  return !entry || isPlainProductName(name, entry);
}

// Label defaults are for a single ingredient. Ingredient presence alone is still
// sufficient for safety/classification consumers, which use ingredientEntryFor.
export function prnDefaultsFor(item: PrnItem): PrnDefaultEntry | null {
  const entry = ingredientEntryFor(item);
  if (!entry) return null;
  const ingredients = new Set(
    (item.rxcuiIngredients ?? []).map((cui) => cui.trim()).filter(Boolean)
  );
  if (ingredients.size > 1) return null;
  // A product CUI with unresolved composition cannot confirm a single ingredient.
  if (
    item.rxcui?.trim() &&
    ingredients.size === 0 &&
    !entry.rxcuis.includes(item.rxcui.trim())
  ) {
    return null;
  }
  if (
    ingredients.size === 1 &&
    !entry.rxcuis.some((cui) => ingredients.has(cui))
  ) {
    return null;
  }
  // A recognized name must not conceal another product behind a matching CUI.
  // With no recognized name, a confirmed sole ingredient supplies the identity.
  const named = ENTRIES.some((candidate) =>
    candidate.synonyms.some((syn) =>
      nameContains(normalize(item.name), normalize(syn))
    )
  );
  if (named && !isPlainProductName(item.name, entry)) return null;
  if (
    item.ingredients?.some(
      (ingredient) =>
        ingredient.name.trim() && !isPlainProductName(ingredient.name, entry)
    )
  )
    return null;
  return entry;
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
// ingredient in the curated dataset, including combination products. RxCUI /
// name-fallback match, so an "Advil"/"Children's Tylenol" row classifies correctly.
export function isAntipyreticIntakeItem(item: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): boolean {
  return isAntipyreticEntry(ingredientEntryFor(item));
}

// Narrows a PRN quick-log list to fever reducers (#4712 judgement 1's dose offer). The
// quick-log projection (`getPrnQuickLogItems`) never selects rxcui/rxcui_ingredients —
// it is the same row every dashboard/episode meds chip already reads — so this takes
// NAME-ONLY, which is exactly isAntipyreticIntakeItem's fallback path when rxcui is
// absent. Generic over the caller's row shape so this stays free of a dependency on
// the queries module's PrnMedForQuickLog type.
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
