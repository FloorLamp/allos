// The read/gather layer for the nutrition domain (issues #577, #579, #580). The
// biomarker→food suggestions live here as the ONE computation both surfaces (biomarker
// detail page, coaching tab) format — "one question, one computation." The pure engine
// is lib/food-suggest.ts; this module only assembles its typed inputs from the
// profile-scoped reads and hands them over.

import { db, today } from "../db";
import { now as clockNow } from "../clock";
import { getCurrentFlaggedBiomarkers } from "./medical";
import { getIntakeSafetyContext } from "./intake";
import { weekWindowStart, recentWindowStart } from "./training/common";
import { suggestFoods, type FoodSuggestion } from "../food-suggest";
import {
  getMetricDailyTotals,
  getWeights,
  getLatestMetricValue,
} from "./metrics";
import {
  getProfileSetting,
  getTimezone,
  getWeekMode,
  getWeekStart,
} from "../settings";
import { zonedDateParts } from "../date";
import { trailingWeeks } from "../week-window";
import type { DisplayFormatPrefs } from "../format-date";
import {
  foodHabitTrendCells,
  HABIT_TREND_WEEKS,
  type HabitWeekCell,
} from "../food-habit-trend";
import {
  foodSlotBoundaries,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "../food-slot";
import { blendFoodOrder } from "../food-rank";
import { PROTEIN_QUICKADD_LAST_KEY } from "../protein-log-write";
import { bodyweightAsOf } from "../bodyweight";
import {
  proteinIntake,
  proteinTarget,
  assessProteinAdequacy,
  estimatedProteinGrams,
  resolveProteinGoalLevel,
  type ProteinAdequacy,
  type ProteinToday,
} from "../protein";
import {
  fiberIntake,
  fiberTarget,
  assessFiberAdequacy,
  estimatedFiberGrams,
  isFiberSupplement,
  fiberDoseGrams,
  type FiberAdequacy,
} from "../fiber";
import {
  getUserSex,
  getUserAge,
  getExcludedFoodGroups,
} from "../settings/profile-attrs";
import { demoteExcludedGroups } from "../dietary-preferences";
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
    // Dietary preferences (#975): the engine filters/substitutes excluded groups. A
    // preference, never a safety gate — a shortfall never disappears, logging never blocks.
    excludedGroups: getExcludedFoodGroups(profileId),
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

// The profile's configured food-slot boundaries (issue #950), read from the RAW
// notify slot-hour settings so "unconfigured" is genuinely detected (getNotifySchedule
// would already have substituted the DEFAULT hours, which we can't tell from a user's
// choice). A fully configured schedule re-anchors the buckets to its midpoints; an
// unset/partial one falls back to the fixed 11:00/15:00 defaults (foodSlotBoundaries).
// Reads only the per-profile settings tier (not owned data), so the profile-scoping
// guard is unaffected.
function profileFoodSlotBoundaries(profileId: number): FoodSlotBoundaries {
  const raw = (key: string): number | null => {
    const v = getProfileSetting(profileId, key);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  return foodSlotBoundaries({
    // Mirrors SUPP_HOUR_KEYS in lib/settings/notifications.ts (the food nudge rides the
    // same morning/midday/evening supplement slots, #682).
    morning: raw("notify_supp_morning_hour"),
    midday: raw("notify_supp_midday_hour"),
    evening: raw("notify_supp_evening_hour"),
  });
}

// The food slot a UTC instant falls into for a profile (its timezone + configured
// boundaries). The ONE derivation both surfaces use, so the web bar's slot chip and
// the ranking can never disagree. Profile-scoped reads only the settings tier.
export function foodSlotForInstant(profileId: number, instant: Date): FoodSlot {
  const { hhmm } = zonedDateParts(getTimezone(profileId), instant);
  return foodSlotForHhmm(hhmm, profileFoodSlotBoundaries(profileId));
}

// The profile's CURRENT food slot (wall-clock now, in its timezone). The Food tab
// renders this as a chip and passes it as the ranking window, so the label and the
// order lead with the same slot.
export function currentFoodSlot(profileId: number): FoodSlot {
  return foodSlotForInstant(profileId, clockNow());
}

// The full food-group catalog ordered so the profile's staples lead WITHIN each
// tier (issue #591), reusing the activity-picker machinery (#195): each food_log
// row over the trailing recent window is weighted by `servings × decayedWeight`
// (60-day half-life, lib/decay.ts) so a recent habit outranks a stale one, and the
// catalog's curated order breaks ties (and is the whole order for a fresh profile).
// The FoodLogBar sections the result by tier, which preserves this order within each
// tier. Profile-scoped via the food_log filter. Every group is returned exactly once
// (a retired/unknown logged slug can't resolve to a catalog group, so it's dropped).
//
// SLOT-AWARE (issue #950): when a `window` is passed, the per-tap food_log_events
// ledger is consulted and each tap whose DERIVED slot matches the window feeds a
// second, slot-specific frecency signal that LEADS the blend, overall frecency
// backfilling (blendFoodOrder — one computation for both the web bar and the Telegram
// nudge, #221). Omitting `window` (or a cold slot with no matching taps) collapses to
// the pre-#950 overall order — no cliff. Presentation-only: ranking never gates what
// can be logged (#559).
export function getFoodGroupLogOrder(
  profileId: number,
  window?: FoodSlot
): FoodGroup[] {
  const t = today(profileId);
  const since = recentWindowStart(profileId);
  const overall = (
    db
      .prepare(
        `SELECT group_key AS name, date, servings FROM food_log
          WHERE profile_id = ? AND date >= ? AND servings > 0`
      )
      .all(profileId, since) as {
      name: string;
      date: string;
      servings: number;
    }[]
  ).map((r) => ({ name: r.name, date: r.date, weight: r.servings }));

  // Slot signal: the per-tap ledger, each event's window DERIVED at read time from its
  // logged_at (so a schedule edit re-derives all history for free). Only when a window
  // is requested — otherwise the blend degrades to pure overall frecency.
  const slot: { name: string; date: string }[] = [];
  if (window) {
    const boundaries = profileFoodSlotBoundaries(profileId);
    const tz = getTimezone(profileId);
    const events = db
      .prepare(
        `SELECT group_key AS name, date, logged_at FROM food_log_events
          WHERE profile_id = ? AND date >= ?`
      )
      .all(profileId, since) as {
      name: string;
      date: string;
      logged_at: string;
    }[];
    for (const e of events) {
      const { hhmm } = zonedDateParts(tz, new Date(e.logged_at));
      if (foodSlotForHhmm(hhmm, boundaries) === window)
        slot.push({ name: e.name, date: e.date });
    }
  }

  // Dietary preferences (#975): demote excluded groups to the TAIL after the frecency
  // blend (composes with slot ranking, #950) but keep them reachable — you can always log
  // what you actually ate. Presentation-only; never gates what can be logged (#559).
  const ranked = demoteExcludedGroups(
    blendFoodOrder(foodGroupSlugs(), overall, slot, t),
    new Set(getExcludedFoodGroups(profileId))
  );
  const out: FoodGroup[] = [];
  for (const slug of ranked) {
    const g = foodGroupBySlug(slug);
    if (g) out.push(g);
  }
  // Defensive: if ranking somehow dropped a catalog group, append it in catalog
  // order so the bar always shows all groups.
  if (out.length !== FOOD_GROUPS.length) {
    const seen = new Set(out.map((g) => g.slug));
    for (const g of FOOD_GROUPS) if (!seen.has(g.slug)) out.push(g);
  }
  return out;
}

// ---- Food-habit N-week consistency trend (issue #954) ----

// The trailing-N-week consistency strip for each tracked food-group habit, keyed by
// frequency_target id. Extends the SAME weekly rollup the this-week progress uses
// (getFrequencyTargetProgress's food_group branch — SUM(servings) over the week
// window) across HABIT_TREND_WEEKS weeks, so the trend's current-week cell equals the
// this-week progress for the same fixture (#221). Week identity follows the profile's
// configured week (mode + start), the SAME definition frequencyPace uses — no second
// "week" (#223). Weeks before a target was created render not-applicable (honest cold
// start), never as misses. Profile-scoped via the frequency_targets + food_log
// filters. Empty map when the profile tracks no food habits.
export function getFoodHabitTrends(
  profileId: number,
  prefs?: DisplayFormatPrefs
): Map<number, HabitWeekCell[]> {
  const targets = db
    .prepare(
      `SELECT id, scope_value, per_week, created_at FROM frequency_targets
        WHERE profile_id = ? AND scope_kind = 'food_group'`
    )
    .all(profileId) as {
    id: number;
    scope_value: string;
    per_week: number;
    created_at: string;
  }[];
  const out = new Map<number, HabitWeekCell[]>();
  if (targets.length === 0) return out;

  const weeks = trailingWeeks(
    today(profileId),
    getWeekMode(profileId),
    getWeekStart(profileId),
    HABIT_TREND_WEEKS
  );
  // One scan of the whole trend window; sum per (group, week) in JS. weeks[0] is the
  // oldest (trailingWeeks returns oldest-first).
  const oldest = weeks[0].start;
  const rows = db
    .prepare(
      `SELECT group_key, date, servings FROM food_log
        WHERE profile_id = ? AND date >= ? AND servings > 0`
    )
    .all(profileId, oldest) as {
    group_key: string;
    date: string;
    servings: number;
  }[];
  const byGroup = new Map<string, { date: string; servings: number }[]>();
  for (const r of rows) {
    const arr = byGroup.get(r.group_key);
    if (arr) arr.push({ date: r.date, servings: r.servings });
    else byGroup.set(r.group_key, [{ date: r.date, servings: r.servings }]);
  }

  for (const t of targets) {
    const entries = byGroup.get(t.scope_value) ?? [];
    const countForWeek = (w: { start: string; end: string }): number =>
      entries.reduce(
        (sum, e) =>
          e.date >= w.start && e.date <= w.end ? sum + e.servings : sum,
        0
      );
    out.set(
      t.id,
      foodHabitTrendCells(
        weeks,
        countForWeek,
        t.per_week,
        // The target's creation DAY (a week fully before it is not-applicable).
        t.created_at.slice(0, 10),
        prefs
      )
    );
  }
  return out;
}

// ---- Protein-grams quick-add (issue #824) ----

// A day's manually-logged protein grams (the Food-tab quick-add running total), or 0
// when the profile logged none that day. Profile-scoped.
export function getProteinLoggedGrams(profileId: number, date: string): number {
  const row = db
    .prepare(`SELECT grams FROM protein_log WHERE profile_id = ? AND date = ?`)
    .get(profileId, date) as { grams: number } | undefined;
  return row?.grams ?? 0;
}

// The profile's protein_log rows on/after `since` (inclusive) — for the per-day logged
// average the adequacy gather sums into the floor. Profile-scoped.
export function getProteinLogEntries(
  profileId: number,
  since: string
): { date: string; grams: number }[] {
  return db
    .prepare(
      `SELECT date, grams FROM protein_log
        WHERE profile_id = ? AND date >= ? AND grams > 0
        ORDER BY date DESC`
    )
    .all(profileId, since) as { date: string; grams: number }[];
}

// The profile's last-used quick-add amount (the repeated scoop size), or null when they
// have never logged grams. Reads the per-profile settings tier (not owned data), so the
// profile-scoping guard is unaffected. The Food tab pre-fills the input with it.
export function getProteinQuickAddPreset(profileId: number): number | null {
  const raw = getProfileSetting(profileId, PROTEIN_QUICKADD_LAST_KEY);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- Protein adequacy (issue #767, #824) ----

// The ONE gather behind the /nutrition protein-adequacy card AND the coaching-tier
// adequacy finding (buildProteinAdequacyFindings). It assembles the pure engine's typed
// inputs from PROFILE-SCOPED reads and returns the pure verdict, so the card and the
// finding are formatters over the same result ("one question, one computation"). Reads
// through getFoodLogEntries / getProteinLogEntries / getMetricDailyTotals / getWeights /
// getLatestMetricValue, all profile-scoped, so the profile-scoping guard is satisfied.
// Returns null when there's no intake signal or no bodyweight to scale by.
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

  // Logged floor (#824): this week's quick-add protein grams / distinct days with grams.
  // Averaged over the days that carry it (same per-basis-average design as estimated), so
  // a partial week isn't diluted by days with no manual entry. Summed with the estimate
  // in proteinIntake (a manual entry is a partial addition, never an eraser).
  const proteinRows = getProteinLogEntries(profileId, weekStart);
  const proteinDays = new Set(proteinRows.map((r) => r.date)).size;
  const loggedWeekGrams = proteinRows.reduce((s, r) => s + r.grams, 0);
  const dailyLogged = proteinDays > 0 ? loggedWeekGrams / proteinDays : null;

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

  const intake = proteinIntake({ dailyTracked, dailyLogged, dailyEstimated });
  const target = proteinTarget({ goal, bodyweightKg, leanMassKg });
  return assessProteinAdequacy(intake, target);
}

// The band-gauge model for the Food tab (issue #974): today so far + this week's daily
// average + the goal band, in ONE gather so the gauge, the quick-add card, and the
// Telegram food-nudge status line format the same numbers (#221). Reuses the SAME pieces
// getProteinAdequacy reads — the target inputs (goal + LBM-preferred bodyweight) and, for
// the weekly marker, getProteinAdequacy's OWN daily-average figure, so the marker can
// never drift from the adequacy card. Today's bar is the #824 composition applied to a
// SINGLE day: today's servings through estimatedProteinGrams + today's quick-add grams, or
// today's tracked reading when one exists. Returns null when there's no target (no
// bodyweight) or no protein data at all (never a bare "0 g" nudge).
export function getProteinToday(profileId: number): ProteinToday | null {
  const t = today(profileId);

  // Target — the SAME inputs getProteinAdequacy uses (goal + LBM-preferred bodyweight).
  const weightsAsc = getWeights(profileId)
    .map((w) => ({ date: w.date, weight_kg: w.weight_kg }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const bodyweightKg = bodyweightAsOf(weightsAsc, t);
  const leanMassKg = getLatestMetricValue(profileId, "lean_mass_kg");
  const goal = resolveProteinGoalLevel(
    getProfileSetting(profileId, "training_goal")
  );
  const target = proteinTarget({ goal, bodyweightKg, leanMassKg });
  if (!target) return null;

  // Today's composition (a SINGLE day, not the weekly average): today's food-group
  // servings → estimated grams + today's quick-add grams, or today's tracked reading.
  const servings = getFoodServingsOnDate(profileId, t);
  const todayServings = [...servings.entries()].map(([slug, n]) => ({
    slug,
    servings: n,
  }));
  const dailyEstimated = estimatedProteinGrams(todayServings);
  const loggedToday = getProteinLoggedGrams(profileId, t);
  const trackedToday = getMetricDailyTotals(profileId, "protein_g").find(
    (r) => r.date === t
  );
  const todayIntake = proteinIntake({
    dailyTracked: trackedToday ? trackedToday.value : null,
    dailyLogged: loggedToday > 0 ? loggedToday : null,
    dailyEstimated,
  });
  const todayGrams = todayIntake?.grams ?? 0;

  // Weekly marker — EXACTLY the adequacy computation's daily-average figure (#221), read
  // from the SAME gather so the two can never disagree.
  const weeklyAverageGrams =
    getProteinAdequacy(profileId)?.intake.grams ?? null;

  // Suppress when there's no protein data at all (a bodyweight-only profile that has never
  // logged) — never a bare "0 g" nudge or an empty gauge.
  if (
    todayGrams <= 0 &&
    (weeklyAverageGrams == null || weeklyAverageGrams <= 0)
  )
    return null;

  return { todayIntake, todayGrams, target, weeklyAverageGrams };
}

// ---- Fiber adequacy (issue #976) ----

// The profile's CONFIRMED (taken) intake-item doses on/after `since` (inclusive), with the
// item name + the amount SNAPSHOTTED onto the log at confirm time. The fiber-supplement
// basis reads this — a skipped dose is excluded (status = 'taken' only), and the snapshot
// amount is what was actually taken (survives a later dosage edit). Profile-scoped through
// the dose's parent item.
export function getConfirmedIntakeDosesInRange(
  profileId: number,
  since: string
): { date: string; name: string; amount: string | null }[] {
  return db
    .prepare(
      `SELECT l.date AS date, s.name AS name, l.amount AS amount
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.date >= ? AND l.status = 'taken'
          AND l.item_id IS NOT NULL`
    )
    .all(profileId, since) as {
    date: string;
    name: string;
    amount: string | null;
  }[];
}

// The ONE gather behind the /nutrition fiber-adequacy card AND the coaching-tier fiber
// finding (buildFiberAdequacyFindings). The #767 protein gather re-instantiated with a
// fourth basis (supplemented). It assembles the pure engine's typed inputs from PROFILE-
// SCOPED reads and returns the pure verdict, so the card and the finding are formatters
// over the same result ("one question, one computation"). Reads through getFoodLogEntries
// / getConfirmedIntakeDosesInRange / getMetricDailyTotals, all profile-scoped, so the
// scoping guard is satisfied. Returns null when there's no intake signal or no DRI target.
//
// Windowing mirrors protein: intake is a PER-DAY average over this week (same
// weekWindowStart), each basis averaged over the distinct days that carry it (so a partial
// week isn't diluted by unlogged days).
export function getFiberAdequacy(profileId: number): FiberAdequacy | null {
  const weekStart = weekWindowStart(profileId);

  // Estimated floor: this week's food-group servings → fiber grams / distinct logged days.
  const entries = getFoodLogEntries(profileId, weekStart);
  const rollup = rollupServings(entries);
  const loggedDays = new Set(entries.map((e) => e.date)).size;
  const estWeekGrams = estimatedFiberGrams(rollup);
  const dailyEstimated = loggedDays > 0 ? estWeekGrams / loggedDays : 0;

  // Supplemented floor: this week's CONFIRMED fiber doses → grams / distinct days with a
  // KNOWN-gram fiber dose (a capsule/unknown-unit dose sets the flag but isn't in the
  // divisor). Snapshot amounts; a skipped dose is already excluded by the query.
  const doseRows = getConfirmedIntakeDosesInRange(profileId, weekStart);
  const fiberGramsByDate = new Map<string, number>();
  let unknownSupplement = false;
  for (const r of doseRows) {
    if (!isFiberSupplement(r.name)) continue;
    const { grams, known } = fiberDoseGrams(r.amount);
    if (known && grams > 0)
      fiberGramsByDate.set(r.date, (fiberGramsByDate.get(r.date) ?? 0) + grams);
    else unknownSupplement = true;
  }
  const suppDays = fiberGramsByDate.size;
  const suppWeekGrams = [...fiberGramsByDate.values()].reduce(
    (s, g) => s + g,
    0
  );
  const dailySupplemented = suppDays > 0 ? suppWeekGrams / suppDays : null;

  // Tracked: integration fiber_g daily totals this week, averaged over days with data.
  const trackedRows = getMetricDailyTotals(profileId, "fiber_g").filter(
    (r) => r.date >= weekStart
  );
  const dailyTracked =
    trackedRows.length > 0
      ? trackedRows.reduce((s, r) => s + r.value, 0) / trackedRows.length
      : null;

  const intake = fiberIntake({
    dailyTracked,
    dailyEstimated,
    dailySupplemented,
    unknownSupplement,
  });
  const target = fiberTarget({
    ageYears: getUserAge(profileId),
    sex: getUserSex(profileId),
  });
  return assessFiberAdequacy(intake, target);
}
