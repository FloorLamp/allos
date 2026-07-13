// The read/gather layer for the nutrition domain (issues #577, #579, #580). The
// biomarker→food suggestions live here as the ONE computation both surfaces (biomarker
// detail page, coaching tab) format — "one question, one computation." The pure engine
// is lib/food-suggest.ts; this module only assembles its typed inputs from the
// profile-scoped reads and hands them over.

import { db, today } from "../db";
import { getCurrentFlaggedBiomarkers } from "./medical";
import { getIntakeSafetyContext } from "./intake";
import { weekWindowStart, recentWindowStart } from "./training/common";
import { suggestFoods, type FoodSuggestion } from "../food-suggest";
import {
  rollupServings,
  type FoodLogEntry,
  type GroupServingTotal,
} from "../food-log";
import {
  FOOD_GROUPS,
  foodGroupBySlug,
  foodGroupSlugs,
  type FoodGroup,
} from "../food-groups";
import { decayedWeight } from "../decay";
import { rankByFrequency } from "../rank-by-frequency";

// Safety-screened food suggestions for the profile's currently-flagged, diet-responsive
// biomarker families. Deterministic; the AI narration tier (deferred, #576 Phase 3)
// would format over this same result. Empty when nothing diet-addressable is flagged.
export function getFoodSuggestions(profileId: number): FoodSuggestion[] {
  const flagged = getCurrentFlaggedBiomarkers(profileId).map((r) => ({
    name: r.name,
    flag: r.flag,
  }));
  if (flagged.length === 0) return [];

  // Allergens + medications + conditions + situations come from the ONE shared
  // intake-safety gather (#661), the same context the AI supplement belt screens
  // against — so a food suggestion and a supplement suggestion can't disagree about
  // the profile's safety facts.
  const { allergens, medications, conditions, situations } =
    getIntakeSafetyContext(profileId);

  return suggestFoods({
    flagged,
    allergens,
    medications,
    conditions,
    situations,
  });
}

// ---- Food-group serving log (issue #579) ----

// A day's logged servings per food group, as a slug→servings map — the state the
// one-tap logging bar reads to show each group's current count. Profile-scoped.
export function getFoodServingsOnDate(
  profileId: number,
  date: string
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT group_key, servings FROM food_log
        WHERE profile_id = ? AND date = ?`
    )
    .all(profileId, date) as { group_key: string; servings: number }[];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.group_key, r.servings);
  return m;
}

// The profile's food-log rows on/after `since` (inclusive), as FoodLogEntry[] for the
// pure rollup. Profile-scoped.
export function getFoodLogEntries(
  profileId: number,
  since: string
): FoodLogEntry[] {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? AND date >= ? AND servings > 0
        ORDER BY date DESC`
    )
    .all(profileId, since) as FoodLogEntry[];
}

// The weekly rollup — servings per group over the profile's "this week" window (the
// SAME week definition the weekly-routine counters use, #223). The ONE computation the
// nutrition card, the trends view, and the #580 habit-target progress all format.
export function getWeeklyFoodRollup(profileId: number): GroupServingTotal[] {
  return rollupServings(
    getFoodLogEntries(profileId, weekWindowStart(profileId))
  );
}

// Servings per group over an explicit [from, to] date window (inclusive) — the Trends
// → Nutrition tab's ranged rollup, honoring the shared date-range control. Same pure
// rollup as the weekly card. Profile-scoped.
export function getFoodRollupInRange(
  profileId: number,
  from: string,
  to: string
): GroupServingTotal[] {
  const rows = db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0
        ORDER BY date DESC`
    )
    .all(profileId, from, to) as FoodLogEntry[];
  return rollupServings(rows);
}

// This week's servings for a single group — the #580 food-habit target progress read,
// routed through the SAME rollup entries so progress and the card can't disagree.
export function getWeeklyServingsForGroup(
  profileId: number,
  groupKey: string,
  weekStart: string = weekWindowStart(profileId)
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(servings), 0) AS n FROM food_log
        WHERE profile_id = ? AND date >= ? AND group_key = ?`
    )
    .get(profileId, weekStart, groupKey) as { n: number };
  return row.n;
}

// The distinct dates this week a group was logged (servings > 0) — for a target framed
// as "N days/week" rather than "N servings/week". Profile-scoped.
export function getWeeklyDaysForGroup(
  profileId: number,
  groupKey: string,
  weekStart: string = weekWindowStart(profileId)
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT date) AS n FROM food_log
        WHERE profile_id = ? AND date >= ? AND group_key = ? AND servings > 0`
    )
    .get(profileId, weekStart, groupKey) as { n: number };
  return row.n;
}

// Convenience: today's date for the acting profile (the logging bar's default day).
export function foodLogToday(profileId: number): string {
  return today(profileId);
}

// The full food-group catalog ordered so the profile's staples lead WITHIN each
// tier (issue #591), reusing the activity-picker machinery (#195): each food_log
// row over the trailing recent window is weighted by `servings × decayedWeight`
// (60-day half-life, lib/decay.ts) so a recent habit outranks a stale one, and
// `rankByFrequency` ranks the curated slugs by that weight (the catalog's curated
// order breaks ties and is the whole order for a fresh profile). The FoodLogBar
// sections the result by tier, which preserves this order within each tier.
// Profile-scoped via the food_log filter. Every group is returned exactly once
// (a retired/unknown logged slug can't resolve to a catalog group, so it's dropped
// — the bar only logs current groups).
export function getFoodGroupLogOrder(profileId: number): FoodGroup[] {
  const t = today(profileId);
  const rows = db
    .prepare(
      `SELECT group_key AS name, date, servings FROM food_log
        WHERE profile_id = ? AND date >= ? AND servings > 0`
    )
    .all(profileId, recentWindowStart(profileId)) as {
    name: string;
    date: string;
    servings: number;
  }[];
  // Aggregate a recency-decayed serving weight per group.
  const weights = new Map<string, number>();
  for (const r of rows) {
    const w = r.servings * decayedWeight(r.date, t);
    weights.set(r.name, (weights.get(r.name) ?? 0) + w);
  }
  const rankRows = [...weights].map(([name, c]) => ({ name, c }));
  const ranked = rankByFrequency(foodGroupSlugs(), rankRows);
  const out: FoodGroup[] = [];
  for (const slug of ranked) {
    const g = foodGroupBySlug(slug);
    if (g) out.push(g);
  }
  // Defensive: if ranking somehow dropped a catalog group, append it in catalog
  // order so the bar always shows all 24.
  if (out.length !== FOOD_GROUPS.length) {
    const seen = new Set(out.map((g) => g.slug));
    for (const g of FOOD_GROUPS) if (!seen.has(g.slug)) out.push(g);
  }
  return out;
}
