// The read/gather layer for the nutrition domain (issues #577, #579, #580). The
// biomarker→food suggestions live here as the ONE computation both surfaces (biomarker
// detail page, coaching tab) format — "one question, one computation." The pure engine
// is lib/food-suggest.ts; this module only assembles its typed inputs from the
// profile-scoped reads and hands them over.

import { utcInstant } from "../date";
import { db, today } from "../db";
import { now as clockNow } from "../clock";
import { getCurrentFlaggedBiomarkers } from "./medical";
import { getIntakeSafetyContext } from "./intake";
import { weekWindowStart } from "./profile-week";
import { recentWindowStart } from "./training/common";
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
import { trailingWeeks } from "../week-window";
import { zonedDateParts } from "../date";
import type { DisplayFormatPrefs } from "../format-date";
import {
  foodHabitTrendCells,
  HABIT_TREND_WEEKS,
  type HabitWeekCell,
} from "../food-habit-trend";
import { foodSlotAnchors, type FoodSlot } from "../food-slot";
import { FOOD_CHECK_LOOKBACK_MIN } from "../food-timing-check";
import {
  foodSlotForProfileInstant,
  profileFoodSlotAnchors,
  profileFoodSlotBoundaries,
} from "../profile-food-slot";
import { blendFoodOrder, slotProximityOccurrences } from "../food-rank";
import { foodEventWindow, type FoodLedgerEvent } from "../food-slot-count";
import { hhmmToMinutes } from "../date";
import { isProteinNudgeKey, PROTEIN_NUDGE_KEY } from "../protein-nudge";
import {
  correctionBursts,
  CORRECTION_FRESH_MIN,
  type CorrectionBurst,
} from "../correction-time";
import type { FoodTapRow } from "../food-log-write";
import { PROTEIN_QUICKADD_LAST_KEY } from "../protein-log-write";
import { bodyweightAsOf } from "../bodyweight";
import {
  proteinIntake,
  proteinTarget,
  proteinTrailingAverage,
  proteinTrailingWindowStart,
  assessProteinAdequacy,
  estimatedProteinGrams,
  type ProteinAdequacy,
  type ProteinDayParts,
  type ProteinToday,
  type ProteinTrailing,
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
  getProteinGoalLevel,
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

// One logged serving as the CORRECTION list renders it (issue #1934): the counts above
// are aggregates and cannot be corrected, because "Berries ×2 in Morning" names no row.
// This is the individual event, carrying the id the ⋯ row action edits and the window it
// currently sits in — derived through the SAME foodEventWindow the tallies use, so the
// row the user corrects is the row the tally counted.
export interface FoodMealEvent {
  id: number;
  groupKey: string;
  // Catalog display name, resolved server-side so the list speaks the #1710 vocabulary.
  name: string;
  date: string;
  mealSlot: FoodSlot;
  // Local wall-clock "HH:MM" the serving was EATEN at, in the profile's timezone, when
  // an eating time was captured (#2019) — null when nobody stated one. The two times
  // are DIFFERENT questions (#2227 decision 7): the list renders `eatenAt ?? loggedTime`
  // so two servings of one group stay distinguishable, and the correction sheet is
  // where the split is answered ("Ate at 19:40." vs "No eating time recorded —
  // logged at 23:40."). Presence here is `time_source`'s first production reader —
  // nothing renders tap-vs-stated, only whether an eating time exists at all.
  eatenAt: string | null;
  // Local wall-clock "HH:MM" the serving was LOGGED at — the audit/tap instant, always
  // present. `logged_at` itself is never edited, so after a correction this is no
  // longer the number the user would recognise; the eating time above is.
  loggedTime: string;
}

export interface FoodMealDay {
  date: string;
  counts: Record<string, number>;
  slotCounts: Record<FoodSlot, Record<string, number>>;
  // The day's individual servings, newest first — the row-action correction surface.
  events: FoodMealEvent[];
}

// Recent meal history for the Food page: the daily source-of-truth counters plus the
// per-serving event ledger grouped into Morning/Midday/Evening. Explicit meal_slot
// values power backfills; older/tap-only events retain the timestamp fallback. Two
// range reads cover the whole picker rather than issuing one query per day and slot.
export function getFoodMealDays(
  profileId: number,
  dates: readonly string[]
): FoodMealDay[] {
  if (dates.length === 0) return [];
  const ordered = [...dates].sort();
  const from = ordered[0];
  const to = ordered[ordered.length - 1];
  const byDate = new Map<string, FoodMealDay>(
    dates.map((date) => [
      date,
      {
        date,
        counts: {},
        slotCounts: { Morning: {}, Midday: {}, Evening: {} },
        events: [],
      },
    ])
  );

  const totals = db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0`
    )
    .all(profileId, from, to) as {
    date: string;
    group_key: string;
    servings: number;
  }[];
  for (const row of totals) {
    const day = byDate.get(row.date);
    if (day) day.counts[row.group_key] = row.servings;
  }

  const events = db
    .prepare(
      `SELECT id, group_key AS name, date, logged_at, meal_slot, eaten_at
         FROM food_log_events
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY logged_at, id`
    )
    .all(profileId, from, to) as (FoodLedgerEvent & { id: number })[];
  const boundaries = profileFoodSlotBoundaries(profileId);
  const tz = getTimezone(profileId);
  for (const event of events) {
    // The reserved protein ranking event is not a food-group serving and has its own
    // grams surface, so it must never appear as a mystery meal chip.
    const group = foodGroupBySlug(event.name);
    if (!group) continue;
    const day = byDate.get(event.date);
    if (!day) continue;
    const slot = foodEventWindow(
      event.logged_at,
      tz,
      boundaries,
      event.meal_slot,
      event.eaten_at
    );
    const slotCounts = day.slotCounts[slot];
    slotCounts[event.name] = (slotCounts[event.name] ?? 0) + 1;
    // Same event, same derived window — the correction row and the tally it feeds are
    // built in one pass, so the list can never offer a row the tally didn't count.
    day.events.push({
      id: event.id,
      groupKey: event.name,
      name: group.name,
      date: event.date,
      mealSlot: slot,
      // The EATING time where one was captured (#2019) and the tap time as separate
      // facts — never collapsed here, so the sheet can say which one it is showing
      // (#2227 decision 7). The list renders eatenAt ?? loggedTime, visually unchanged
      // for a row nobody timed.
      eatenAt: event.eaten_at
        ? zonedDateParts(tz, new Date(event.eaten_at)).hhmm
        : null,
      loggedTime: zonedDateParts(tz, new Date(event.logged_at)).hhmm,
    });
  }
  // Newest first: the serving most likely to need correcting is the one just tapped.
  for (const day of byDate.values()) day.events.reverse();

  return dates.map((date) => byDate.get(date)!);
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

// The raw PER-DAY serving rows over an inclusive [from, to] window — the food–drug
// ledger's input (#2021), which needs each day separately (a same-day co-occurrence, a
// week-over-week swing) rather than the group totals `getFoodRollupInRange` folds them
// into. Same table, same filter, one row per (date, group). Profile-scoped.
export function getFoodServingsInRange(
  profileId: number,
  from: string,
  to: string
): FoodLogEntry[] {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0
        ORDER BY date, group_key`
    )
    .all(profileId, from, to) as FoodLogEntry[];
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

// The food slot a UTC instant falls into for a profile (its timezone + configured
// boundaries). The ONE derivation both surfaces use, so the web bar's slot chip and
// the ranking can never disagree. Profile-scoped reads only the settings tier.
export function foodSlotForInstant(profileId: number, instant: Date): FoodSlot {
  return foodSlotForProfileInstant(profileId, instant);
}

// The profile's CURRENT food slot (wall-clock now, in its timezone). The Food tab
// renders this as a chip and passes it as the ranking window, so the label and the
// order lead with the same slot.
export function currentFoodSlot(profileId: number): FoodSlot {
  return foodSlotForInstant(profileId, clockNow());
}

// THE food-group ranking (issue #1980 — one function, both surfaces). Returns the
// ranked KEYS the web log bar and the Telegram nudge both render: every food-group slug
// exactly once, plus the reserved `__protein__` pseudo-group when the profile tracks
// protein (#1073). Keys rather than FoodGroup rows because `__protein__` is not a catalog
// group — each surface resolves a key to its own control (a serving row / a "+Xg protein"
// button), which is the ONLY difference between them.
//
// The order: the profile's staples lead (issue #591, reusing the activity-picker
// machinery #195) — each food_log row over the trailing recent window weighted by
// `servings × decayedWeight` (60-day half-life, lib/decay.ts), so a recent habit outranks
// a stale one and the curated catalog order breaks ties (and IS the whole order for a
// fresh profile). SLOT-AWARE (issue #950, by PROXIMITY since #2019): with a `window`,
// each food_log_events tap contributes a second, slot-specific signal weighted by how
// near its EATING minute (`eaten_at`, or the tap minute when none was captured) fell to
// that window's anchor — no bucket equality anywhere, so there is no boundary cliff and a
// tap that never claimed a meal still participates. That signal LEADS the blend with
// overall frecency backfilling; omitting `window` collapses to the pre-#950 overall order
// — no cliff. Then ONE demotion: the profile's EXCLUDED groups
// (#975) drop to the tail, still reachable, because you can always log what you actually
// ate. Nothing else reorders — see lib/food-rank.ts on why the capped demotion was
// reversed (#1980, reversing #1822 item 5).
//
// Presentation-only: ranking gates ORDER, never what can be logged (#559). Profile-scoped
// via the food_log / food_log_events filters.
export function rankFoodGroups(profileId: number, window?: FoodSlot): string[] {
  const { t, overall, slot } = gatherFoodRankingSignals(profileId, window);
  const curated = curatedFoodRankKeys(profileId);
  const ranked = demoteExcludedGroups(
    blendFoodOrder(curated, overall, slot, t),
    new Set(getExcludedFoodGroups(profileId))
  );
  // Defensive: if ranking somehow dropped a key, append it in CURATED order so every
  // surface still offers everything. Compared against the curated list itself (#1980) —
  // FOOD_GROUPS.length would be the wrong yardstick now that the curated list can carry
  // the protein pseudo-entry.
  if (ranked.length !== curated.length) {
    const seen = new Set(ranked);
    for (const key of curated) if (!seen.has(key)) ranked.push(key);
  }
  return ranked;
}

// The web log bar's view of `rankFoodGroups`: the ranked catalog groups resolved to rows,
// plus WHERE the protein pseudo-entry sits among them. A formatter over the one ranking
// (#221) — it re-decides nothing, it only resolves keys the bar has to render as a
// different control.
export interface FoodBarOrder {
  // The ranked catalog groups, in rank order.
  groups: FoodGroup[];
  // How many ranked groups sit AHEAD of the protein pseudo-entry, or null when the
  // profile doesn't track protein and the entry isn't ranked at all. The bar places its
  // protein control at this position; null renders it after the ranked rows rather than
  // dropping it, so a first shake is still one tap away (#559 — a cold start must not be
  // a dead end).
  proteinRank: number | null;
}

export function getFoodBarOrder(
  profileId: number,
  window?: FoodSlot
): FoodBarOrder {
  const ranked = rankFoodGroups(profileId, window);
  const groups: FoodGroup[] = [];
  let proteinRank: number | null = null;
  for (const key of ranked) {
    if (key === PROTEIN_NUDGE_KEY) {
      proteinRank = groups.length;
      continue;
    }
    const g = foodGroupBySlug(key);
    if (g) groups.push(g);
  }
  // Defensive, as above but on the RESOLVED side: an unresolvable slug (a retired group
  // still in the ledger) must not shrink the bar.
  if (groups.length !== FOOD_GROUPS.length) {
    const seen = new Set(groups.map((g) => g.slug));
    for (const g of FOOD_GROUPS) if (!seen.has(g.slug)) groups.push(g);
  }
  return { groups, proteinRank };
}

// The overall (food_log daily counter) + slot (food_log_events ledger) frecency inputs
// blendFoodOrder consumes for a window — gathered ONCE for the one ranking every surface
// reads (#221/#1980). The slot signal weights each event by PROXIMITY (#2019) between the
// minute it was EATEN and the window's own anchor, both read at query time, so a schedule
// edit re-weights all history for free and no event has to have claimed a meal.
function gatherFoodRankingSignals(
  profileId: number,
  window?: FoodSlot
): {
  t: string;
  overall: { name: string; date: string; weight: number }[];
  slot: { name: string; date: string; weight?: number }[];
} {
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

  // Slot signal: the per-tap ledger, weighted by PROXIMITY to the requested window's
  // anchor (#2019) rather than by bucket equality. Only when a window is requested —
  // otherwise the blend degrades to pure overall frecency.
  //
  // Each event contributes at the minute it was EATEN when one was captured (`eaten_at`,
  // #2019), and at the minute it was TAPPED otherwise. The minute is read in the
  // profile's timezone; the anchor is the profile's own configured slot hour. Nothing
  // here asks which BUCKET an event fell in, so the 14:59/15:01 cliff is gone and an
  // event that never claimed a meal still participates.
  let slot: { name: string; date: string; weight?: number }[] = [];
  if (window) {
    const tz = getTimezone(profileId);
    const events = db
      .prepare(
        `SELECT group_key AS name, date, logged_at, meal_slot, eaten_at
           FROM food_log_events
          WHERE profile_id = ? AND date >= ?`
      )
      .all(profileId, since) as FoodLedgerEvent[];
    slot = slotProximityOccurrences(
      events.map((e) => ({
        name: e.name,
        date: e.date,
        minuteOfDay: hhmmToMinutes(
          zonedDateParts(tz, new Date(e.eaten_at ?? e.logged_at)).hhmm
        ),
      })),
      profileFoodSlotAnchors(profileId)[window]
    );
  }
  return { t, overall, slot };
}

// Whether the profile logs protein (has any protein_log history, or a saved quick-add
// scoop preset) — the gate for the "+Xg protein" nudge button (#1073). A non-tracker never
// sees the reserved __protein__ pseudo-group in the ranked keys. Reads a profile-scoped
// owned table (protein_log) + the per-profile settings tier.
export function profileTracksProtein(profileId: number): boolean {
  if (getProteinQuickAddPreset(profileId) != null) return true;
  const row = db
    .prepare(`SELECT 1 FROM protein_log WHERE profile_id = ? LIMIT 1`)
    .get(profileId);
  return !!row;
}

// The curated key list `rankFoodGroups` blends (#1073, one list since #1980): the
// food-group catalog slugs, with the reserved __protein__ pseudo-group inserted MID-LIST
// for a protein-tracking profile — so at cold start (no __protein__ slot signal yet) it
// ranks mid-list rather than dominating or vanishing, and once it accrues slot events it
// climbs the slots the profile actually shakes. A non-tracker's list is the plain catalog,
// so __protein__ never reaches a surface that has nothing to log into it.
function curatedFoodRankKeys(profileId: number): string[] {
  const slugs = foodGroupSlugs();
  if (!profileTracksProtein(profileId)) return slugs;
  const mid = Math.floor(slugs.length / 2);
  return [...slugs.slice(0, mid), PROTEIN_NUDGE_KEY, ...slugs.slice(mid)];
}

// `getFoodSlotServingsOnDate` — the #1016 slot-scoped nudge button "(n)" suffix — used
// to live here. #2019 retired the suffix (the Telegram buttons and tally line both read
// the DAY total, lib/notifications/food.ts), which left this query with zero production
// callers, and #2227 deleted it rather than keep a derivation advertising a consumer
// that no longer exists. Per-window tallies live where they are rendered: the web meal
// grouping (getFoodMealDays.slotCounts) and the write cores' placement counts.

// How many PROTEIN taps landed on a day (#1073/#1379). The reserved __protein__ key
// deliberately never reaches the `food_log` day counter — reserved-key discipline keeps a
// shake from becoming a serving — so its "(n)" suffix has to be counted off the ledger it
// DOES write to. One row per tap, so the count is taps, not grams; the day's grams stay on
// the nudge's own protein line. Profile-scoped via the food_log_events filter.
export function getProteinTapsOnDate(profileId: number, date: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM food_log_events
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .get(profileId, date, PROTEIN_NUDGE_KEY) as { n: number };
  return row.n;
}

// ---- The live food-ledger check behind a dose's declared timing (issue #2022) ----

// Minutes since the profile's most recent logged serving, or null when the ledger holds
// none within the lookback window. The ONE ledger read behind the dose reminder's
// food-timing clause (lib/food-timing-check.ts owns what to say about it).
//
// THE EATING INSTANT WINS OVER THE TAP STAMP. `eaten_at` is a stated or tap-contracted
// measurement of when the food actually went in (#2019); `logged_at` is when the button
// was pressed. COALESCE puts the better fact first and falls back to the tap for the
// rows — historical, and every un-stated web log — that genuinely have no eating time.
// That is the whole of #2019 slotting in "transparently": no branch, no second read.
//
// The window is bounded by the check's own lookback, so this is a handful of rows on the
// busiest day, and a serving older than any window the clause consults costs nothing to
// ignore. The reserved `__protein__` row COUNTS: a protein shake is eating, and a check
// about whether anything went in recently that excluded it would be wrong in the one
// direction that matters (claiming nothing is logged when something is). Profile-scoped
// via the food_log_events filter.
export function getMinutesSinceLastFoodLog(
  profileId: number,
  now: Date = clockNow()
): number | null {
  const since = utcInstant(
    new Date(now.getTime() - FOOD_CHECK_LOOKBACK_MIN * 60_000)
  );
  const row = db
    .prepare(
      `SELECT MAX(COALESCE(eaten_at, logged_at)) AS ate
         FROM food_log_events
        WHERE profile_id = ? AND COALESCE(eaten_at, logged_at) >= ?`
    )
    .get(profileId, since) as { ate: string | null };
  if (!row.ate) return null;
  const at = new Date(row.ate).getTime();
  if (!Number.isFinite(at)) return null;
  return (now.getTime() - at) / 60_000;
}

// ---- Eating-time correction rows (issue #2019) ----

// The profile's recent food taps as the correction offer reads them: row id, the
// IMMUTABLE tap stamp (burst identity and freshness key on this), the instant the row
// currently STANDS at (#2206 — what the header states and what a chip counts back from),
// and a display name for a lone-tap row. Bounded by the freshness window the offer itself
// uses, so the read is a handful of rows however busy the day was.
//
// THE ROW SET IS A QUERY, not a memory. Nothing records that some earlier keyboard
// rendered a correction row, which is exactly why the rows survive a rebuild, a pointer
// rotation and a restart: whichever food keyboard is currently live renders the offers
// the LEDGER still justifies. Profile-scoped via the food_log_events filter.
export function getRecentFoodTaps(
  profileId: number,
  now: Date = clockNow()
): FoodTapRow[] {
  const since = utcInstant(
    new Date(now.getTime() - CORRECTION_FRESH_MIN * 60_000)
  );
  const rows = db
    .prepare(
      `SELECT id, group_key, logged_at, eaten_at FROM food_log_events
        WHERE profile_id = ? AND logged_at >= ?
        ORDER BY logged_at, id
        LIMIT 100`
    )
    .all(profileId, since) as {
    id: number;
    group_key: string;
    logged_at: string;
    eaten_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    groupKey: r.group_key,
    tapAt: r.logged_at,
    // Where the row STANDS (#2206): the chips count back from it and the row's header
    // states it, so a corrected serving stops being displayed at its tap time and a
    // second chip tap composes onto the first. Read regardless of `time_source` — the
    // question is what the ledger holds, not who put it there.
    statedAt: r.eaten_at,
    // The reserved __protein__ pseudo-group has no catalog entry, so it is named for
    // what it is rather than rendered as a mystery slug.
    label: isProteinNudgeKey(r.group_key)
      ? "Protein"
      : (foodGroupBySlug(r.group_key)?.name ?? r.group_key),
  }));
}

// The correction rows one food keyboard should carry right now — the fresh taps,
// collapsed into bursts, newest first, capped. One computation for the send, every
// rebuild, and the hourly sweep (#221), so a chat can never show a chip the handler
// would refuse.
export function getFoodCorrectionBursts(
  profileId: number,
  now: Date = clockNow()
): CorrectionBurst[] {
  return correctionBursts(getRecentFoodTaps(profileId, now), now);
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

  // Goal level — the profile's training goal (Settings → Nutrition, #1503), or the
  // documented default when they have not picked one. ONE reader for every surface.
  const goal = getProteinGoalLevel(profileId);

  const intake = proteinIntake({ dailyTracked, dailyLogged, dailyEstimated });
  const target = proteinTarget({ goal, bodyweightKg, leanMassKg });
  return assessProteinAdequacy(intake, target);
}

// The TRAILING 7-day protein average (issue #1917) — the number a card labelled
// "7-day average" shows, as opposed to getProteinAdequacy's week-to-date figure
// above (which still answers "am I meeting my target this week?" for the adequacy
// card, its coaching finding, and the Food-tab gauge's marker).
//
// This gather only ASSEMBLES: it reads each day's three protein parts from the same
// profile-scoped sources the adequacy gather uses, and hands them to the pure
// `proteinTrailingAverage`, which composes each day through `proteinIntake` and
// takes the window through the ONE shared `trailingAverage` helper. No window
// arithmetic and no mean live here — that is the whole point of #1909's boundary.
function getProteinTrailing(
  profileId: number,
  todayStr: string
): ProteinTrailing {
  const since = proteinTrailingWindowStart(todayStr);

  const estimatedByDate = new Map<
    string,
    { slug: string; servings: number }[]
  >();
  for (const e of getFoodLogEntries(profileId, since)) {
    const list = estimatedByDate.get(e.date);
    const serving = { slug: e.group_key, servings: e.servings };
    if (list) list.push(serving);
    else estimatedByDate.set(e.date, [serving]);
  }

  const loggedByDate = new Map<string, number>();
  for (const r of getProteinLogEntries(profileId, since)) {
    loggedByDate.set(r.date, (loggedByDate.get(r.date) ?? 0) + r.grams);
  }

  const trackedByDate = new Map<string, number>();
  for (const r of getMetricDailyTotals(profileId, "protein_g")) {
    if (r.date >= since) trackedByDate.set(r.date, r.value);
  }

  const dates = new Set([
    ...estimatedByDate.keys(),
    ...loggedByDate.keys(),
    ...trackedByDate.keys(),
  ]);
  const days: ProteinDayParts[] = [...dates].map((date) => ({
    date,
    dailyTracked: trackedByDate.get(date) ?? null,
    dailyLogged: loggedByDate.get(date) ?? null,
    dailyEstimated: estimatedProteinGrams(estimatedByDate.get(date) ?? []),
  }));
  // The reads above stop at the window, so the series alone cannot tell a FIRST-ever
  // log from a stale one: both arrive as "nothing complete". One existence check per
  // source answers it, and the day-one decision stays the shared helper's.
  return proteinTrailingAverage(days, todayStr, {
    hasEarlierHistory: hasProteinSignalBefore(profileId, since),
  });
}

// Whether the profile logged, tracked or estimated any protein BEFORE `date` — the
// truncation fact the trailing window needs, as three indexed existence probes
// rather than a second read of the whole history. Profile-scoped.
function hasProteinSignalBefore(profileId: number, date: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM food_log
         WHERE profile_id = ? AND date < ? AND servings > 0
       UNION ALL
       SELECT 1 AS hit FROM protein_log
         WHERE profile_id = ? AND date < ? AND grams > 0
       UNION ALL
       SELECT 1 AS hit FROM metric_samples
         WHERE profile_id = ? AND metric = 'protein_g' AND date < ?
       LIMIT 1`
    )
    .get(profileId, date, profileId, date, profileId, date) as
    { hit: number } | undefined;
  return row != null;
}

// The protein target as of a calendar day. The recent-day picker needs historical
// estimates to use weight available on that day rather than leaking a later weigh-in
// backward. Lean mass remains the profile's latest preferred target basis, matching the
// existing adequacy gather.
function proteinTargetOnDate(profileId: number, date: string) {
  const weightsAsc = getWeights(profileId)
    .map((w) => ({ date: w.date, weight_kg: w.weight_kg }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const bodyweightKg = bodyweightAsOf(weightsAsc, date);
  const leanMassKg = getLatestMetricValue(profileId, "lean_mass_kg");
  const goal = getProteinGoalLevel(profileId);
  return proteinTarget({ goal, bodyweightKg, leanMassKg });
}

// A SINGLE calendar day's protein estimate for the seven-day Food picker: that day's
// food-group servings + quick-add grams, or its tracked protein reading when present.
// The legacy ProteinToday shape is reused by the gauge; its weekly marker is deliberately
// null because a historical day should not be visually mixed with the CURRENT week's
// average. Returns null when that date has no protein signal or no target.
export function getProteinOnDate(
  profileId: number,
  date: string
): ProteinToday | null {
  const target = proteinTargetOnDate(profileId, date);
  if (!target) return null;

  const servings = getFoodServingsOnDate(profileId, date);
  const dayServings = [...servings.entries()].map(([slug, n]) => ({
    slug,
    servings: n,
  }));
  const dailyEstimated = estimatedProteinGrams(dayServings);
  const loggedOnDate = getProteinLoggedGrams(profileId, date);
  const trackedOnDate = getMetricDailyTotals(profileId, "protein_g").find(
    (r) => r.date === date
  );
  const dayIntake = proteinIntake({
    dailyTracked: trackedOnDate ? trackedOnDate.value : null,
    dailyLogged: loggedOnDate > 0 ? loggedOnDate : null,
    dailyEstimated,
  });
  const dayGrams = dayIntake?.grams ?? 0;
  if (dayGrams <= 0) return null;

  return {
    todayIntake: dayIntake,
    todayGrams: dayGrams,
    target,
    weeklyAverageGrams: null,
    // Null for the same reason the weekly marker is: a HISTORICAL day must not be
    // mixed with a window anchored on today. getProteinToday fills both in.
    trailing: { grams: null, dayOne: false },
  };
}

// The band-gauge model for the Food tab (issue #974): today so far + this week's daily
// average + the goal band, in ONE gather so the gauge, the quick-add card, and the
// Telegram food-nudge status line format the same numbers (#221). The date-specific
// composition comes from getProteinOnDate; today's formatter adds the adequacy gather's
// current-week marker. It preserves the in-progress 0 g gauge when the week has protein
// history but today does not.
export function getProteinToday(profileId: number): ProteinToday | null {
  const t = today(profileId);
  const onDate = getProteinOnDate(profileId, t);

  // Weekly marker — EXACTLY the adequacy computation's daily-average figure (#221), read
  // from the SAME gather so the two can never disagree. WEEK-TO-DATE: it is the number
  // the weekly adequacy verdict is reached on, and the gauge's marker labels it as such.
  const weeklyAverageGrams =
    getProteinAdequacy(profileId)?.intake.grams ?? null;

  // …and the TRAILING 7-day average (#1917), a different question with its own
  // computation, for the surfaces that say "7-day average".
  const trailing = getProteinTrailing(profileId, t);

  if (onDate) return { ...onDate, weeklyAverageGrams, trailing };

  // Suppress when there's no protein data at all (a bodyweight-only profile that has
  // never logged) — never a bare "0 g" nudge or empty gauge.
  if (weeklyAverageGrams == null || weeklyAverageGrams <= 0) return null;
  const target = proteinTargetOnDate(profileId, t);
  if (!target) return null;

  return {
    todayIntake: null,
    todayGrams: 0,
    target,
    weeklyAverageGrams,
    trailing,
  };
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

// A SINGLE calendar day's fiber estimate for the seven-day Food picker. Unlike
// getFiberAdequacy's current-week daily average, this combines only the selected day's
// food servings, confirmed fiber doses, and tracked fiber total. That keeps Yesterday's
// display historical rather than silently repeating this week's figure.
export function getFiberOnDate(
  profileId: number,
  date: string
): FiberAdequacy | null {
  const servings = [...getFoodServingsOnDate(profileId, date).entries()].map(
    ([slug, n]) => ({ slug, servings: n })
  );
  const dailyEstimated = estimatedFiberGrams(servings);

  let dailySupplemented = 0;
  let unknownSupplement = false;
  for (const row of getConfirmedIntakeDosesInRange(profileId, date)) {
    if (row.date !== date || !isFiberSupplement(row.name)) continue;
    const { grams, known } = fiberDoseGrams(row.amount);
    if (known && grams > 0) dailySupplemented += grams;
    else unknownSupplement = true;
  }

  const trackedOnDate = getMetricDailyTotals(profileId, "fiber_g").find(
    (row) => row.date === date
  );
  const intake = fiberIntake({
    dailyTracked: trackedOnDate?.value ?? null,
    dailyEstimated,
    dailySupplemented: dailySupplemented > 0 ? dailySupplemented : null,
    unknownSupplement,
  });
  const target = fiberTarget({
    ageYears: getUserAge(profileId),
    sex: getUserSex(profileId),
  });
  return assessFiberAdequacy(intake, target);
}
