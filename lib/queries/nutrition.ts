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
  getMetricDailyTotals,
  getWeights,
  getLatestMetricValue,
} from "./metrics";
import { getProfileSetting } from "../settings";
import { bodyweightAsOf } from "../bodyweight";
import {
  proteinIntake,
  proteinTarget,
  assessProteinAdequacy,
  estimatedProteinGrams,
  resolveProteinGoalLevel,
  type ProteinAdequacy,
} from "../protein";
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
import { rankByRecentFrequency } from "../rank-by-frequency";

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
  // Rank the catalog by recency-decayed serving weight (each serving decays with
  // age) — the shared #857 computation, food weighting each occurrence by its servings.
  const ranked = rankByRecentFrequency(
    foodGroupSlugs(),
    rows.map((r) => ({ name: r.name, date: r.date, weight: r.servings })),
    t
  );
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

// ---- Protein adequacy (issue #767) ----

// The ONE gather behind the /nutrition protein-adequacy card AND the coaching-tier
// adequacy finding (buildProteinAdequacyFindings). It assembles the pure engine's typed
// inputs from PROFILE-SCOPED reads and returns the pure verdict, so the card and the
// finding are formatters over the same result ("one question, one computation"). Adds no
// owned SQL (reads through getFoodLogEntries / getMetricDailyTotals / getWeights /
// getLatestMetricValue, all already profile-scoped), so the profile-scoping guard is
// unaffected. Returns null when there's no intake signal or no bodyweight to scale by.
//
// Windowing: intake is a PER-DAY average over this week — the estimated floor averages the
// week's summed food-group protein over the distinct days actually logged (so a partial
// week isn't diluted by unlogged days), and the tracked basis averages the integration's
// daily protein_g totals over the days that carry a reading. Same week the servings
// rollup uses (weekWindowStart), so the card's "this week" numbers line up.
export function getProteinAdequacy(profileId: number): ProteinAdequacy | null {
  const weekStart = weekWindowStart(profileId);

  // Estimated floor: this week's food-group servings → protein grams / distinct logged days.
  const entries = getFoodLogEntries(profileId, weekStart);
  const rollup = rollupServings(entries);
  const loggedDays = new Set(entries.map((e) => e.date)).size;
  const estWeekGrams = estimatedProteinGrams(rollup);
  const dailyEstimated = loggedDays > 0 ? estWeekGrams / loggedDays : 0;

  // Tracked: integration protein_g daily totals this week, averaged over days with data.
  const trackedRows = getMetricDailyTotals(profileId, "protein_g").filter(
    (r) => r.date >= weekStart
  );
  const dailyTracked =
    trackedRows.length > 0
      ? trackedRows.reduce((s, r) => s + r.value, 0) / trackedRows.length
      : null;

  // Bodyweight (ascending for bodyweightAsOf) + latest lean mass (preferred when present).
  const t = today(profileId);
  const weightsAsc = getWeights(profileId)
    .map((w) => ({ date: w.date, weight_kg: w.weight_kg }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const bodyweightKg = bodyweightAsOf(weightsAsc, t);
  const leanMassKg = getLatestMetricValue(profileId, "lean_mass_kg");

  // Goal level — the profile's training goal when set (#719 onboarding hook), else the
  // "active" default; the pure resolver maps whatever string lands.
  const goal = resolveProteinGoalLevel(
    getProfileSetting(profileId, "training_goal")
  );

  const intake = proteinIntake({ dailyTracked, dailyEstimated });
  const target = proteinTarget({ goal, bodyweightKg, leanMassKg });
  return assessProteinAdequacy(intake, target);
}
