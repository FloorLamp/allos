// Curated OTC PRN dosing DEFAULTS matcher (issue #798). The single-item lookup twin
// of the food-drug matcher (lib/food-drug-interactions.ts): given ONE intake item
// (its name + cached RxCUI(s)), return the committed OTC label defaults for that
// ingredient — the adult redose interval/max to PRE-FILL, and (for ibuprofen /
// acetaminophen) the label's pediatric weight-band chart. No DB, no network — the
// facts live in the committed, hand-maintained, CITED lib/prn-defaults.json.
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

import data from "./prn-defaults.json";
import { itemRxcuis } from "./drug-interactions";

// One weight band from an OTC pediatric Drug Facts chart: an inclusive LOWER weight
// bound (pounds) and the label's mg for that band. Bands are ordered ascending; the
// lookup picks the highest band whose minLbs <= the child's weight (see prn-dosing).
export interface PediatricBand {
  minLbs: number;
  mg: number;
}

// A common product formulation carrying its concentration (mg per mL), so a mL
// suggestion can be derived from a band's mg — but ONLY after the user picks THEIR
// product's concentration (issue #798). mg is canonical; mL is opt-in. `slug` is the
// formulation's stable machine identifier (the form's picker value).
export interface PrnFormulation {
  slug: string;
  label: string;
  mgPerMl: number;
}

export interface PrnAdultDefaults {
  minIntervalHours: number;
  maxDailyCount: number;
  maxDailyMg: number;
  doseMgLow: number;
  doseMgHigh: number;
}

export interface PrnPediatricDefaults {
  // Hard age gate (label's own): below this age the lookup refuses with ageGateText
  // instead of any dose ("ask a doctor"). Rendered as a refusal, never a computed
  // exception (issue #798 non-goals).
  minAgeMonths: number;
  ageGateText: string;
  bands: PediatricBand[];
  formulations: PrnFormulation[];
}

export interface PrnDefaultEntry {
  // Stable machine identifier for the ingredient ("ibuprofen", "acetaminophen", …).
  slug: string;
  label: string;
  rxcuis: string[];
  synonyms: string[];
  adult: PrnAdultDefaults;
  // ABSENT for ingredients with no OTC pediatric weight-band table (aspirin — Reye's;
  // naproxen — not for under-12; diphenhydramine — age-dosed, not weight-banded).
  pediatric?: PrnPediatricDefaults;
  source: string;
}

const ENTRIES = (data as { ingredients: PrnDefaultEntry[] }).ingredients;

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
