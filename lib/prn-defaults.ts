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

// ---- Ingredient presence in a display name, and #5230's identity detector ---------
//
// ONE containment core, TWO callers, and the negation guard belongs to only one of
// them. Both questions are asked of the same curated synonyms with the same normalizer,
// so they must not drift apart; they are not the same question, so they must not be the
// same function.
//
//   prnEntriesNamedIn   — PRESENCE. Unguarded. "is this ingredient in the bottle?"
//   prnProductsNamedIn  — IDENTITY.   Guarded. "what does this name say it IS?"
//
// Nothing here loosens what a DOSE derives from: prnDefaultsFor keeps its exact whole-
// name match, so `Kirkland Ibuprofen 200 mg` detects ibuprofen and derives nothing.

// The curated entries whose synonyms appear as whole words in the name, with NO
// negation guard. INTERNAL: presence is the only question it answers.
function prnEntriesNamedIn(name: string): PrnDefaultEntry[] {
  const itemNorm = normalize(name);
  return ENTRIES.filter((entry) =>
    entry.synonyms.some((synonym) => nameContains(itemNorm, normalize(synonym)))
  );
}

// A matched synonym is NEGATED when the name says the product is not in the bottle.
// Two legs, both required (#5230 ruling, 2026-09-09): preceded by `no`, `non` or
// `without`, or followed by `free`. `free <X>` does NOT negate and `<modifier>-free
// <synonym>` does NOT negate, which is why the trailing leg is positional rather than
// "the word `free` appears" — `Sugar-free ibuprofen` is ibuprofen, and it is the
// commonest modifier on the shelf.
const NEGATING_BEFORE: ReadonlySet<string> = new Set(["no", "non", "without"]);
const NEGATING_AFTER = "free";

// Every start index at which the synonym's tokens appear contiguously in the name's.
function tokenMatchStarts(
  nameTokens: readonly string[],
  synTokens: readonly string[]
): number[] {
  const starts: number[] = [];
  if (!synTokens.length) return starts;
  for (let i = 0; i + synTokens.length <= nameTokens.length; i++) {
    if (synTokens.every((token, k) => nameTokens[i + k] === token))
      starts.push(i);
  }
  return starts;
}

// Whether the name asserts this synonym as present at least once. Adjacency is over the
// normalized token stream, and for a MULTI-TOKEN synonym the trailing neighbour is the
// token after its LAST token, not after its first: `Acetylsalicylic acid-free rub` reads
// `acetylsalicylic acid | free`, and looking one token past `acetylsalicylic` finds
// `acid` and misses the negation entirely.
function nameAsserts(nameTokens: readonly string[], synNorm: string): boolean {
  const synTokens = synNorm.split(" ").filter(Boolean);
  return tokenMatchStarts(nameTokens, synTokens).some((start) => {
    const before = start > 0 ? nameTokens[start - 1] : null;
    const after = nameTokens[start + synTokens.length] ?? null;
    return !(
      (before != null && NEGATING_BEFORE.has(before)) ||
      after === NEGATING_AFTER
    );
  });
}

// #5230 ruling 9's identity detector: the curated products this bottle's NAME says it
// is, minus the ones the name negates. Returns ENTRIES, never a boolean — ruling 10 has
// to COUNT them, and a name listing two medicines has no single identity to dose from.
//
// IDENTITY ONLY. This is never an input to a dose figure, and it never reads the row's
// codes: a detector carrying the CUI leg would compare the stored code to itself and
// the name/code mismatch could never fire.
export function prnProductsNamedIn(name: string): PrnDefaultEntry[] {
  const nameTokens = normalize(name).split(" ").filter(Boolean);
  return ENTRIES.filter((entry) =>
    entry.synonyms.some((synonym) =>
      nameAsserts(nameTokens, normalize(synonym))
    )
  );
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

// The strength suggestions an OTC label offers for the amount field: the adult
// tier's low and high figures, de-duplicated for the ingredients whose label states
// one strength twice. Empty for anything the curated dataset does not name — the
// suggestion list stays silent rather than inventing a strength (#846).
export function otcStrengthOptions(
  entry: PrnDefaultEntry | null | undefined
): string[] {
  if (!entry) return [];
  return [
    ...new Set([`${entry.adult.doseMgLow} mg`, `${entry.adult.doseMgHigh} mg`]),
  ];
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
//
// THE NAME LEG IS THE UNGUARDED ONE, deliberately. `Non-Aspirin Pain Reliever` IS
// acetaminophen and IS a fever reducer; it reaches this dataset only through the word
// `aspirin`, so a negation guard on this leg would flip it to false and stop
// lib/school-return-data.ts treating it as fever-masking — a child cleared to return to
// school on a fever-free count a fever reducer was suppressing. Presence is not
// identity: #5230's identity detector composes the guard on top of the same core
// (prnProductsNamedIn) and this predicate keeps asking only "is the ingredient in
// there".
export function isAntipyreticIntakeItem(item: PrnItem): boolean {
  const cuis = itemRxcuis(item);
  return (
    ENTRIES.some(
      (entry) =>
        isAntipyreticEntry(entry) && entry.rxcuis.some((cui) => cuis.has(cui))
    ) || prnEntriesNamedIn(item.name).some(isAntipyreticEntry)
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
