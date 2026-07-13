// The ONE pure computation behind the food-group serving log (issue #579): the weekly
// rollup — servings per group over a window. Deliberately the SINGLE place this is
// computed so the journal/nutrition card, the trends view, and (later) the food-habit
// target progress (#580) are all formatters over the same result ("one question, one
// computation"). Pure — no DB/clock; the caller windows the rows and passes them in.

import {
  FOOD_GROUPS,
  foodGroupBySlug,
  type FoodGroupTier,
} from "./food-groups";

// A logged row as the rollup consumes it (the query layer maps food_log rows to this).
export interface FoodLogEntry {
  date: string;
  group_key: string;
  servings: number;
}

// One group's summed servings over the window, with its catalog display fields. A
// retired/unknown slug still surfaces (name = slug, tier "neutral") so history renders.
export interface GroupServingTotal {
  slug: string;
  name: string;
  tier: FoodGroupTier;
  servings: number;
}

// Sum servings per group over the given entries (the caller supplies the window's rows).
// Groups with zero servings are omitted. Ordered by the catalog's curated order
// (encourage-first), with any unknown/retired slug appended in first-seen order after.
export function rollupServings(entries: FoodLogEntry[]): GroupServingTotal[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (!(e.servings > 0)) continue;
    totals.set(e.group_key, (totals.get(e.group_key) ?? 0) + e.servings);
  }

  const out: GroupServingTotal[] = [];
  // Catalog order first.
  for (const g of FOOD_GROUPS) {
    const s = totals.get(g.slug);
    if (s == null) continue;
    out.push({ slug: g.slug, name: g.name, tier: g.tier, servings: s });
    totals.delete(g.slug);
  }
  // Any remaining (retired/unknown) slugs, stable order.
  for (const [slug, servings] of totals) {
    out.push({ slug, name: slug, tier: "neutral", servings });
  }
  return out;
}

// The total servings logged across all groups in the window — a small headline number.
export function totalServings(entries: FoodLogEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.servings > 0 ? e.servings : 0), 0);
}

// Servings for a single group over the window — the food-habit target progress read
// (#580) is this against a per-week target. Kept here so target progress and the rollup
// card can never disagree on the count.
export function servingsForGroup(
  entries: FoodLogEntry[],
  groupKey: string
): number {
  return entries.reduce(
    (sum, e) =>
      sum + (e.group_key === groupKey && e.servings > 0 ? e.servings : 0),
    0
  );
}

// Re-export the catalog lookup so callers reach it through the food-log surface too.
export { foodGroupBySlug };
