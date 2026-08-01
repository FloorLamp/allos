// The supplement name picker ORDER (issue #1677). Pure — no DB, no network.
//
// The catalog is grouped by CATEGORY (vitamins, minerals, omega, …), so an empty
// combobox — 8 rows, source order — shows eight vitamins and nothing else: Vitamin A,
// Vitamin C, D3, D3+K2, E, K2, B12, B-Complex. Whether that is the right first screen
// has nothing to do with which category happens to be typed first in the file.
//
// Same three tiers and the same discipline as the medication ranker (`rank-core`/#1490:
// stable facts, bucketed presence, no raw-recency jitter):
//
//   1. what this profile actually takes — an ACTIVE supplement outranks a retired one
//   2. a curated commonality head, so a fresh profile opens on what people take
//   3. the rest of the catalog in its category order (unchanged as a tail)
//
// ORDERING ONLY: membership never changes and everything stays reachable by search.

import { SUPPLEMENT_CATALOG } from "./supplement-catalog";
import { rankByFrequency } from "./rank-by-frequency";

// One supplement on this profile's shelf. `current` is the stable fact that buckets it:
// an active item leads a retired one. Retired items still count — a supplement you
// cycled off is far more likely to be re-added than a catalog entry you've never taken.
export interface SupplementUsage {
  name: string;
  current: boolean;
}

// Presence buckets, combined with MAX (see medication-rank.ts) so duplicate rows for
// the same supplement can never outrank a genuinely different one.
export const CURRENT_SUPPLEMENT_WEIGHT = 4;
export const PAST_SUPPLEMENT_WEIGHT = 1;

// The curated commonality head — the supplements a first-time picker should open on,
// ordered by how commonly they are actually taken rather than by catalog category.
// Hand-maintained; every entry must be a real catalog name (pinned by
// lib/__tests__/supplement-rank.test.ts) so a catalog rename can't leave a dangling
// head entry. Informational ordering, NOT advice.
export const COMMON_SUPPLEMENTS: readonly string[] = [
  "Vitamin D3",
  "Magnesium Glycinate",
  "Omega-3",
  "Multivitamin",
  "Vitamin C",
  "Zinc",
  "Probiotics",
  "Creatine Monohydrate",
  "Vitamin B12",
  "Iron",
  "Melatonin",
  "Whey Protein",
  "Fish Oil",
  "Calcium",
  "Collagen Peptides",
  "Electrolytes",
  "B-Complex",
  "Folate",
  "Vitamin K2",
  "L-Theanine",
  "Ashwagandha",
  "Turmeric",
  "Curcumin",
  "CoQ10",
  "Psyllium Husk",
  "Fiber",
  "Glycine",
  "Caffeine",
];

// Every catalog name, in file (category) order — the pre-#1677 picker source.
export function supplementCatalogNames(): string[] {
  return SUPPLEMENT_CATALOG.map((c) => c.name);
}

// The curated options with the commonality head in front and the rest of the catalog
// behind it in its existing category order — what a profile with NO supplements sees.
// Same membership as the raw catalog, different order.
let curatedCache: string[] | null = null;
export function curatedSupplementOptions(): string[] {
  if (curatedCache) return curatedCache;
  const known = new Map(
    supplementCatalogNames().map((n) => [n.toLowerCase(), n])
  );
  const head: string[] = [];
  const taken = new Set<string>();
  for (const name of COMMON_SUPPLEMENTS) {
    const canonical = known.get(name.toLowerCase());
    if (!canonical || taken.has(canonical.toLowerCase())) continue;
    head.push(canonical);
    taken.add(canonical.toLowerCase());
  }
  const tail = supplementCatalogNames().filter(
    (n) => !taken.has(n.toLowerCase())
  );
  curatedCache = [...head, ...tail];
  return curatedCache;
}

// The supplement name picker order for one profile (#1677). Usage beats the curated
// head beats the catalog tail; an active item beats a retired one; ties keep curated
// order, so a profile with no supplements gets `curatedSupplementOptions()` byte for
// byte. A supplement the catalog doesn't list (free text) is appended by its own
// weight, so the profile's own names lead their own picker.
export function rankedSupplementOptions(
  usage: readonly SupplementUsage[]
): string[] {
  const weights = new Map<string, { name: string; c: number }>();
  const known = new Map(
    supplementCatalogNames().map((n) => [n.toLowerCase(), n])
  );
  for (const row of usage) {
    const raw = row.name.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const name = known.get(key) ?? raw;
    const weight = row.current
      ? CURRENT_SUPPLEMENT_WEIGHT
      : PAST_SUPPLEMENT_WEIGHT;
    const prev = weights.get(key);
    if (!prev) weights.set(key, { name, c: weight });
    else if (weight > prev.c) prev.c = weight;
  }
  return rankByFrequency(curatedSupplementOptions(), [...weights.values()]);
}
