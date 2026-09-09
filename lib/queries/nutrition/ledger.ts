// The food-group serving LEDGER (issues #579, #1934, #1980) — one of the three
// submodules behind lib/queries/nutrition.ts. The day and range reads over
// food_daily_totals / food_log_events, the meal grouping and correction rows the
// Food page renders, the paged history, the slot helpers, and THE food-group
// ranking every logging surface orders by. Every read is profile-scoped.

import { db, today } from "../../db";
import { cache } from "../../request-cache";
import { now as clockNow } from "../../clock";
import { weekWindowStart } from "../profile-week";
import { recentWindowStart } from "../training/common";
import { getProfileSetting, getTimezone } from "../../settings";
import { zonedDateParts } from "../../date";
import {
  foodSlotForHhmm,
  foodSlotWindow,
  type FoodSlot,
  type FoodSlotWindow,
} from "../../food-slot";
import { ALCOHOL_FOOD_GROUP } from "../../substance-use";
import {
  foodSlotForProfileInstant,
  profileFoodSlotAnchors,
  profileFoodSlotBoundaries,
} from "../../profile-food-slot";
import { blendFoodOrder, slotProximityOccurrences } from "../../food-rank";
import { foodEventWindow, type FoodLedgerEvent } from "../../food-slot-count";
import { hhmmToMinutes } from "../../date";
import { PROTEIN_NUDGE_KEY } from "../../protein-nudge";
import { PROTEIN_QUICKADD_LAST_KEY } from "../../protein-daily-totals-write";
import { getExcludedFoodGroups } from "../../settings/profile-attrs";
import { demoteExcludedGroups } from "../../dietary-preferences";
import {
  rollupServings,
  type FoodDailyServingTotal,
  type GroupServingTotal,
} from "../../food-daily-totals";
import {
  FOOD_GROUPS,
  foodGroupBySlug,
  foodGroupSlugs,
  type FoodGroup,
} from "../../food-groups";
import { pageCount, pageOffset } from "../../pagination";
import { bestKnownInstant } from "../../row-instants";

// ---- Food-group serving log (issue #579) ----

// A day's logged servings per food group, as a slug→servings map — the state the
// one-tap logging bar reads to show each group's current count. Profile-scoped.
export function getFoodServingsOnDate(
  profileId: number,
  date: string
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT group_key, servings FROM food_daily_totals
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
  // present. `recorded_at` itself is never edited, so after a correction this is no
  // longer the number the user would recognise; the eating time above is.
  loggedTime: string;
  // What the person wrote about THIS serving (#5304), or null. Carried so the
  // correction sheet opens on the note it is about to correct — a sheet seeded without
  // it would show an empty field over stored text.
  notes: string | null;
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
      `SELECT date, group_key, servings FROM food_daily_totals
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
      `SELECT id, group_key AS name, date, recorded_at, meal_slot, occurred_at, notes
         FROM food_log_events
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY recorded_at, id`
    )
    .all(profileId, from, to) as (FoodLedgerEvent & {
    id: number;
    notes: string | null;
  })[];
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
      event.recorded_at,
      tz,
      boundaries,
      event.meal_slot,
      event.occurred_at
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
      eatenAt: event.occurred_at
        ? zonedDateParts(tz, new Date(event.occurred_at)).hhmm
        : null,
      loggedTime: zonedDateParts(tz, new Date(event.recorded_at)).hhmm,
      notes: event.notes,
    });
  }
  // Newest first: the serving most likely to need correcting is the one just tapped.
  for (const day of byDate.values()) day.events.reverse();

  return dates.map((date) => byDate.get(date)!);
}

export interface FoodLedgerRow {
  id: number;
  group_key: string;
  date: string;
  recorded_at: string;
  meal_slot: FoodSlot | null;
  occurred_at: string | null;
  notes: string | null;
}

/**
 * One page of serving rows. The event table, rather than its daily counter, is the
 * row identity because corrections and undo name a single serving. Reserved
 * ranking/protein observations are excluded by joining the curated food vocabulary
 * in memory at the filter boundary and by the write store's reserved-key prefix.
 */
// THE CALLER'S BOUND IS THE BOUND (#3958). This clamped to 100 while the deleted
// ledger routes drove it with `?page=`, where 100 was a page-size sanity cap. Its
// one caller now is the record's gather, which asks for `?show` rows and offers
// "Load more" when the read was cut — so a silent 100 made the control INERT from
// the first click and put a year of logging permanently out of reach. The dose
// reader beside it never had a clamp, which is why the defect was invisible on the
// kind everyone tested. Bounded only against zero and a fraction now, exactly as
// `getIntakeDoseLedgerPage` is; `HISTORY_MAX_SHOW` is where the real ceiling lives.
export function getFoodLedgerPage(
  profileId: number,
  from: string,
  options: {
    untilDate?: string | null;
    groupKey?: string;
    /**
     * Drop the DRINKS (#860/#944 put a standard drink on this store because a drink
     * IS one serving of the curated `alcohol` group, which is a STORAGE decision and
     * not a claim that a drink is a meal). Off by default: this reader answers "what
     * servings are on the food log", and a drink is one.
     *
     * NAMED FOR WHAT IT DROPS (#3295). It was `excludeSubstanceGroups`, which reads
     * as a rule about substances in general and is a promise this clause cannot
     * keep: it pushes exactly one argument, `ALCOHOL_FOOD_GROUP`, and alcohol is the
     * only substance that can ever be here — `substanceDef(key).ledger` is `food-log`
     * for alcohol and `substance-log` for nicotine, cannabis and every custom key,
     * and neither `nicotine` nor `cannabis` is a food group at all. Phase 2 gives the
     * others their own event ledger; it does not widen this one, and the name should
     * not have implied that it would.
     *
     * `/history` turns it on so a drink is filed ONCE. The record reads this same
     * function again for the alcohol group alone and composes those rows under the
     * `substance` kind (see the drinks composer in lib/history.ts), because the age
     * gate and the person's own terms both belong to that kind — so without this
     * clause the same drink would be two rows.
     *
     * IN SQL AND NOT AT THE CALL SITE, because `total` is what "Load more" reads:
     * filtering the returned rows in memory would leave the count claiming rows the
     * bound had already dropped.
     */
    excludeAlcohol?: boolean;
  },
  page: number,
  pageSize: number
): { rows: FoodLedgerRow[]; total: number; page: number } {
  const requestedPage = Math.max(1, Math.floor(page));
  const boundedSize = Math.max(1, Math.floor(pageSize));
  const where = ["date >= ?", "substr(group_key, 1, 2) != '__'"];
  if (options.excludeAlcohol) {
    where.push("group_key != ?");
  }
  const args: Array<string | number> = [profileId, from];
  if (options.excludeAlcohol) args.push(ALCOHOL_FOOD_GROUP);
  if (options.untilDate) {
    where.push("date <= ?");
    args.push(options.untilDate);
  }
  if (options.groupKey) {
    where.push("group_key = ?");
    args.push(options.groupKey);
  }
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events
          WHERE profile_id = ? AND ${where.join(" AND ")}`
      )
      .get(...args) as {
      n: number;
    }
  ).n;
  const boundedPage = Math.min(requestedPage, pageCount(total, boundedSize));
  const rows = db
    .prepare(
      `SELECT id, group_key, date, recorded_at, meal_slot, occurred_at, notes
         FROM food_log_events
        WHERE profile_id = ? AND ${where.join(" AND ")}
        ORDER BY date DESC, COALESCE(occurred_at, recorded_at) DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(
      ...args,
      boundedSize,
      pageOffset(boundedPage, boundedSize)
    ) as FoodLedgerRow[];
  return { rows, total, page: boundedPage };
}

// The profile's food-log rows on/after `since` (inclusive), as FoodDailyServingTotal[] for the
// pure rollup. Profile-scoped.
//
// REQUEST-CACHED (#3369 item 2): the weekly rollup, the food-habit target progress and
// the paired-observation factor reader each open the same window on one render, and one
// render asks twice over two different `since` days. Keyed on (profileId, since), so
// the two windows stay two reads and a household render still reads once per profile.
// NO WRITER CAN INTERVENE (lib/queries/AGENTS.md): nothing that writes food logs reads
// these totals in the same request. Callers iterate or filter what they get back.
export const getFoodDailyServingTotals = cache(
  function getFoodDailyServingTotals(
    profileId: number,
    since: string
  ): FoodDailyServingTotal[] {
    return db
      .prepare(
        `SELECT date, group_key, servings FROM food_daily_totals
        WHERE profile_id = ? AND date >= ? AND servings > 0
        ORDER BY date DESC`
      )
      .all(profileId, since) as FoodDailyServingTotal[];
  }
);

// The weekly rollup — servings per group over the profile's "this week" window (the
// SAME week definition the weekly-routine counters use, #223). The ONE computation the
// nutrition card, the trends view, and the #580 habit-target progress all format.
export function getWeeklyFoodRollup(profileId: number): GroupServingTotal[] {
  return rollupServings(
    getFoodDailyServingTotals(profileId, weekWindowStart(profileId))
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
      `SELECT date, group_key, servings FROM food_daily_totals
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0
        ORDER BY date DESC`
    )
    .all(profileId, from, to) as FoodDailyServingTotal[];
  return rollupServings(rows);
}

// The raw PER-DAY serving rows over an inclusive [from, to] window — the food–drug
// ledger's input (#2021), which needs each day separately (a same-day co-occurrence, a
// week-over-week swing) rather than the group totals `getFoodRollupInRange` folds them
// into. Same table, same filter, one row per (date, group). Profile-scoped.
export function getFoodDailyServingTotalsInRange(
  profileId: number,
  from: string,
  to: string
): FoodDailyServingTotal[] {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_daily_totals
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0
        ORDER BY date, group_key`
    )
    .all(profileId, from, to) as FoodDailyServingTotal[];
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

// The profile's current food slot TOGETHER WITH the local-minute span that slot owns
// (#3265) — one clock read, one boundary read, so the two halves are provably the same
// derivation. A caller that took the slot from here and the span from somewhere else is
// how the composed usual-routine one-tap ended up standing until midnight while its
// dashboard placement expired at 21:00; a caller cannot pair a slot with a foreign
// window if the pair arrives already made.
export function currentFoodSlotWindow(
  profileId: number
): FoodSlotWindow & { slot: FoodSlot } {
  const boundaries = profileFoodSlotBoundaries(profileId);
  const slot = foodSlotForHhmm(
    zonedDateParts(getTimezone(profileId), clockNow()).hhmm,
    boundaries
  );
  return { slot, ...foodSlotWindow(slot, boundaries) };
}

// THE food-group ranking (issue #1980 — one function, both surfaces). Returns the
// ranked KEYS the web log bar and the Telegram nudge both render: every food-group slug
// exactly once, plus the reserved `__protein__` pseudo-group when the profile tracks
// protein (#1073). Keys rather than FoodGroup rows because `__protein__` is not a catalog
// group — each surface resolves a key to its own control (a serving row / a "+Xg protein"
// button), which is the ONLY difference between them.
//
// The order: the profile's staples lead (issue #591, reusing the activity-picker
// machinery #195) — each food_daily_totals row over the trailing recent window weighted by
// `servings × decayedWeight` (60-day half-life, lib/decay.ts), so a recent habit outranks
// a stale one and the curated catalog order breaks ties (and IS the whole order for a
// fresh profile). SLOT-AWARE (issue #950, by PROXIMITY since #2019): with a `window`,
// each food_log_events tap contributes a second, slot-specific signal weighted by how
// near its EATING minute (`occurred_at`, or the tap minute when none was captured) fell to
// that window's anchor — no bucket equality anywhere, so there is no boundary cliff and a
// tap that never claimed a meal still participates. That signal LEADS the blend with
// overall frecency backfilling; omitting `window` collapses to the pre-#950 overall order
// — no cliff. Then ONE demotion: the profile's EXCLUDED groups
// (#975) drop to the tail, still reachable, because you can always log what you actually
// ate. Nothing else reorders — see lib/food-rank.ts on why the capped demotion was
// reversed (#1980, reversing #1822 item 5).
//
// Presentation-only: ranking gates ORDER, never what can be logged (#559). Profile-scoped
// via the food_daily_totals / food_log_events filters.
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

// The overall (food_daily_totals daily counter) + slot (food_log_events ledger) frecency inputs
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
        `SELECT group_key AS name, date, servings FROM food_daily_totals
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
  // Each event contributes at the minute it was EATEN when one was captured (`occurred_at`,
  // #2019), and at the minute it was TAPPED otherwise. The minute is read in the
  // profile's timezone; the anchor is the profile's own configured slot hour. Nothing
  // here asks which BUCKET an event fell in, so the 14:59/15:01 cliff is gone and an
  // event that never claimed a meal still participates.
  //
  // `meal_slot` IS DELIBERATELY NOT READ — decided, not incidental (#2269 decision 2).
  // Ranking learns WHEN THIS PERSON EATS, and the eating minute is honestly when even
  // for a row carrying a deliberate Meal override: the 02:00 snack hand-filed under
  // Evening was still eaten at 02:00, and letting the override contribute at its
  // window's anchor would teach the nudge a time nobody ate at. Tallies and ranking
  // answer DIFFERENT questions ("which section does this serving file under" vs "when
  // does this person eat") and may legitimately disagree on an overridden row; #2269's
  // log-path rule is what confines that disagreement to deliberate overrides.
  let slot: { name: string; date: string; weight?: number }[] = [];
  if (window) {
    const tz = getTimezone(profileId);
    const events = db
      .prepare(
        `SELECT group_key AS name, date, recorded_at, occurred_at
           FROM food_log_events
          WHERE profile_id = ? AND date >= ?`
      )
      .all(profileId, since) as Omit<FoodLedgerEvent, "meal_slot">[];
    slot = slotProximityOccurrences(
      events.flatMap((event) => {
        const instant = bestKnownInstant("food_log_events", { ...event });
        if (!instant.known) return [];
        return [
          {
            name: event.name,
            date: event.date,
            minuteOfDay: hhmmToMinutes(
              zonedDateParts(tz, new Date(instant.at)).hhmm
            ),
          },
        ];
      }),
      profileFoodSlotAnchors(profileId)[window]
    );
  }
  return { t, overall, slot };
}

// Whether the profile logs protein (has any protein_daily_totals history, or a saved quick-add
// scoop preset) — the gate for the "+Xg protein" nudge button (#1073). A non-tracker never
// sees the reserved __protein__ pseudo-group in the ranked keys. Reads a profile-scoped
// owned table (protein_daily_totals) + the per-profile settings tier.
export function profileTracksProtein(profileId: number): boolean {
  if (getProteinQuickAddPreset(profileId) != null) return true;
  const row = db
    .prepare(`SELECT 1 FROM protein_daily_totals WHERE profile_id = ? LIMIT 1`)
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

// The profile's last-used quick-add amount (the repeated scoop size), or null when they
// have never logged grams. Reads the per-profile settings tier (not owned data), so the
// profile-scoping guard is unaffected. The Food tab pre-fills the input with it.
export function getProteinQuickAddPreset(profileId: number): number | null {
  const raw = getProfileSetting(profileId, PROTEIN_QUICKADD_LAST_KEY);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// `getFoodSlotServingsOnDate` — the #1016 slot-scoped nudge button "(n)" suffix — used
// to live here. #2019 retired the suffix (the Telegram buttons and tally line both read
// the DAY total, lib/notifications/food.ts), which left this query with zero production
// callers, and #2227 deleted it rather than keep a derivation advertising a consumer
// that no longer exists. Per-window tallies live where they are rendered: the web meal
// grouping (getFoodMealDays.slotCounts) and the write cores' placement counts.

// How many PROTEIN taps landed on a day (#1073/#1379). The reserved __protein__ key
// deliberately never reaches the `food_daily_totals` day counter — reserved-key discipline keeps a
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
