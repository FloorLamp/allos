// Food REGULARITY and HABITS (issues #2380, #2376, #2022, #2019, #954) — one of
// the three submodules behind lib/queries/nutrition.ts. What this profile logs in a
// window nearly every time, the presentable habits and the "log my usual" offer, the
// windows a day's ledger derived, the live recency checks behind the dose-timing
// clause and the correction offer, and the N-week habit trend. Reads the ledger
// module's shared range readers rather than re-deriving them. Profile-scoped.

import { utcInstant } from "../../date";
import { db, today } from "../../db";
import { now as clockNow } from "../../clock";
import { getTimezone, getWeekMode, getWeekStart } from "../../settings";
import { trailingWeeks } from "../../week-window";
import type { DisplayFormatPrefs } from "../../format-date";
import {
  foodHabitTrendCells,
  HABIT_TREND_WEEKS,
  type HabitWeekCell,
} from "../../food-habit-trend";
import { FOOD_SLOTS, type FoodSlot } from "../../food-slot";
import {
  FOOD_REGULARITY_SPAN_DAYS,
  foodPeriodRegularity,
  foodRegularity,
  foodRegularityWindowStart,
  habitualFoodGroups,
  usualFoodOffer,
  type FoodDayEvent,
  type FoodRegularity,
  type FoodRegularityEvent,
} from "../../food-regularity";
import {
  foodHabitObservations,
  type FoodHabitObservation,
} from "../../food-habit-observation";
import { cadenceDirection } from "../../cadence";
import { ALCOHOL_FOOD_GROUP } from "../../substance-use";
import { FOOD_CHECK_LOOKBACK_MIN } from "../../food-timing-check";
import { profileFoodSlotBoundaries } from "../../profile-food-slot";
import { foodEventWindow, type FoodLedgerEvent } from "../../food-slot-count";
import { isProteinNudgeKey, PROTEIN_NUDGE_KEY } from "../../protein-nudge";
import { USUAL_BACKFILL } from "../../logged-via";
import { CORRECTION_FRESH_MIN } from "../../correction-time";
import type { FoodTapRow } from "../../food-log-write";
import { foodGroupBySlug } from "../../food-groups";
import { getFoodDailyServingTotalsInRange, getFoodMealDays } from "./ledger";

// ---- Food regularity: what this profile logs in a window nearly every time (#2380) ----

// The profile's food-group regularity, per meal window, over the bounded recent span.
// A SECOND read of the ledger the ranking already reads (#2380): same events, same
// `foodEventWindow` derivation, different question — the ranking asks which group leads
// an order, this asks which groups show up nearly every time a window is logged at all.
//
// Windows come from the SAME precedence the tallies and the ranking use, so a habit is a
// habit however its window was established (declared on the backfill tab, captured as an
// eating time, or derived from the tap). A retired slug is dropped — nothing downstream
// can name it.
//
// ── `__protein__` IS MEASURED HERE (#4379, owner ruling 2026-08-30) ──────────
//
// It used to be dropped beside the retired slugs, on the stated reason that "a habit has
// to be a catalog group, because everything downstream names one to the user". That
// reason does not hold for THIS measure's consumers: both of them are the usual bundle,
// and the bundle's own vocabulary already names the key — "+30g protein" is the nudge
// button's shipped label (#1073). Dropping it meant the one physical event the bundle
// exists to cover (#2458: a smoothie, "one physical event and five taps") wrote every
// row except the protein one, however many mornings the ledger held.
//
// It is lifted for this measure ONLY, which is what "no parallel measure" means here:
// `getFoodPeriodHabits` runs the day-grain read and keeps its exclusion, because the
// coaching sentence it feeds ("you consistently …") was not re-ruled. Anything that
// grows a third consumer of this function inherits the key and must say what it does
// with it — the split is the CONSUMER's, not the arithmetic's.
//
// ── THE EVIDENCE GUARD (#4118) ───────────────────────────────────────────────
//
// Rows stamped `usual-backfill` are EXCLUDED here, and here only. They are the composed
// one-tap aimed at a past day, and this measure is what decides that the one-tap should
// be offered at all — so counting them would let the write manufacture its own reason:
// backfill three mornings, and the fourth is offered because of the three. Every other
// reader keeps them, because they record something that happened: the day view, the
// tallies, adherence, the fasting reads, the rankings.
//
// `IS NOT` rather than `!=`: `logged_via` is NULL on every row written before #3087, and
// `!=` would silently drop all of that history from the measure. SQLite's `IS NOT` is
// null-safe, so a NULL stamp stays evidence — which it is.
//
// Reads a bounded ~3 weeks of one profile's events. Profile-scoped via the
// food_log_events filter.
export function getFoodRegularity(profileId: number): FoodRegularity {
  const t = today(profileId);
  const from = foodRegularityWindowStart(t);
  const rows = db
    .prepare(
      `SELECT group_key AS name, date, recorded_at, meal_slot, occurred_at
         FROM food_log_events
        WHERE profile_id = ? AND date >= ? AND date <= ?
          AND logged_via IS NOT ?`
    )
    .all(profileId, from, t, USUAL_BACKFILL) as FoodLedgerEvent[];
  const tz = getTimezone(profileId);
  const boundaries = profileFoodSlotBoundaries(profileId);
  const events: FoodRegularityEvent[] = [];
  for (const row of rows) {
    if (!foodGroupBySlug(row.name) && !isProteinNudgeKey(row.name)) continue;
    events.push({
      groupKey: row.name,
      date: row.date,
      window: foodEventWindow(
        row.recorded_at,
        tz,
        boundaries,
        row.meal_slot,
        row.occurred_at
      ),
    });
  }
  return foodRegularity(events, {
    today: t,
    spanDays: FOOD_REGULARITY_SPAN_DAYS,
  });
}

// The food groups whose regularity may be MEASURED but never presented back as an
// expectation (#2380, applying #998's language). Two memberships, both declared:
//
//   • a group whose food_daily_totals counter IS a substance ledger — alcohol, whose taps are
//     the substance scope's own rows (lib/substance-daily-totals-write.ts). Excluded
//     unconditionally, target or no target: "you usually have alcohol in the evening"
//     is a sentence this app does not say, and whether the user has declared a weekly
//     cap does not change what saying it would do.
//   • a group carrying an active CAP-DIRECTION frequency target, selected by
//     `cadenceDirection` rather than by subtracting a scope kind — so a future inverted
//     scope joins this exclusion by declaring its direction instead of by being
//     remembered (lib/cadence.ts).
//
// NOT excluded: the catalog's `limit` tier. #1980 ruled that tier never moves a group
// into or out of a fast path — a group you log often is a group you need to log fast.
// Profile-scoped via the frequency_targets filter.
export function getCapDirectionFoodGroups(profileId: number): Set<string> {
  const excluded = new Set<string>([ALCOHOL_FOOD_GROUP]);
  const rows = db
    .prepare(
      `SELECT scope_kind, scope_value FROM frequency_targets WHERE profile_id = ?`
    )
    .all(profileId) as { scope_kind: string; scope_value: string }[];
  for (const row of rows) {
    if (cadenceDirection(row.scope_kind) !== "cap") continue;
    // A cap-direction target's scope_value names either a food group directly (a future
    // inverted food scope) or a substance whose ledger is a food group. Anything else
    // (nicotine, cannabis — their own table) has no food group to exclude.
    if (foodGroupBySlug(row.scope_value)) excluded.add(row.scope_value);
    if (row.scope_value === ALCOHOL_FOOD_GROUP)
      excluded.add(ALCOHOL_FOOD_GROUP);
  }
  return excluded;
}

// The habitual groups per window — the presentable half of the measure, cap-direction
// groups removed. `[]` for a window under the declared gate: no expectation, which a
// consumer must never render as a habit broken.
export function getHabitualFoodGroups(
  profileId: number
): Record<FoodSlot, string[]> {
  const measure = getFoodRegularity(profileId);
  const excluded = getCapDirectionFoodGroups(profileId);
  return Object.fromEntries(
    FOOD_SLOTS.map((window) => [
      window,
      habitualFoodGroups(measure[window], { excluded }).map((g) => g.groupKey),
    ])
  ) as Record<FoodSlot, string[]>;
}

// The PERIOD's stateable food habits (#2397) — the same measure as `getFoodRegularity`
// asked of a whole day over a whole period, and the same exclusion applied to it.
//
// ONE READ, day-grained: the daily rollup the recap's food line already loads for this
// window, projected to (group, day) pairs. The window measure's per-event slot
// derivation is deliberately NOT re-run here — a period habit is a DIET ("fatty fish
// about twice a week"), not a rhythm ("fermented, most mornings"), so which meal a
// group landed in is not part of the question and the cheaper day-grain read is the
// honest one at ninety days.
//
// `__protein__` and any retired slug drop out: an observation names a catalog group to
// the user, and a reserved key names nothing. Cap-direction groups drop out through the
// SAME `getCapDirectionFoodGroups` the window measure uses — "you consistently consume
// alcohol" is the sentence #2380 already refused in a shorter window, and a longer one
// does not make it sayable (#998/#2397).
//
// Profile-scoped via the food_daily_totals filter inside the rollup read.
export function getFoodPeriodHabits(
  profileId: number,
  from: string,
  to: string
): FoodHabitObservation[] {
  const events: FoodDayEvent[] = [];
  for (const row of getFoodDailyServingTotalsInRange(profileId, from, to)) {
    if (!foodGroupBySlug(row.group_key)) continue;
    events.push({ groupKey: row.group_key, date: row.date });
  }
  return foodHabitObservations(foodPeriodRegularity(events, { from, to }), {
    excluded: getCapDirectionFoodGroups(profileId),
  });
}

// WHAT A "log my usual" TAP WOULD WRITE right now, for one window on the profile's
// today: the habitual groups that window still has nothing logged for. Empty means no
// offer — either no habit, or enough of it already logged that the ranked bar is again
// the faster path. The pure rule is `usualFoodOffer`; this only assembles its two
// inputs from the profile's own state, which is what lets the write core re-derive the
// SAME list against fresh state rather than trusting a submitted one.
export function getUsualFoodOffer(
  profileId: number,
  window: FoodSlot,
  date: string
): string[] {
  const habitual = habitualFoodGroups(getFoodRegularity(profileId)[window], {
    excluded: getCapDirectionFoodGroups(profileId),
  }).map((g) => g.groupKey);
  const logged =
    getFoodMealDays(profileId, [date])[0]?.slotCounts[window] ?? {};
  const already = new Set(
    Object.keys(logged).filter((slug) => (logged[slug] ?? 0) > 0)
  );
  // THE REDUCTION COVERS PROTEIN TOO (#4379). The meal grouping above deliberately drops
  // the reserved key — a shake is not a food-group serving and must not render as a
  // mystery meal chip — so a protein tap is invisible to it, and without this the bundle
  // would keep offering grams already in the window. "Any `__protein__` tap already in
  // the window drops the member, exactly as a logged group falls out" is the ruling's own
  // sentence, and this is where a member falls out.
  //
  // ASKED ONLY WHERE IT CAN CHANGE THE ANSWER. The read is a query, and this function is
  // on the dashboard's path for every profile — the query-budget test priced it at +1
  // per persona when it ran unconditionally, on six personas that have no protein habit
  // to reduce. A window whose habitual set does not name the key cannot lose it, so the
  // question is only worth asking where the feature applies.
  if (
    habitual.includes(PROTEIN_NUDGE_KEY) &&
    proteinWindowsLoggedOn(profileId, date).has(window)
  )
    already.add(PROTEIN_NUDGE_KEY);
  return usualFoodOffer(habitual, already);
}

// WHICH WINDOWS THE RESERVED PROTEIN KEY LANDED IN, on one day (#4379). The same
// `foodEventWindow` precedence every other read of this ledger uses, so a shake counts
// for the window the tallies count it for. Profile-scoped via the food_log_events filter.
export function proteinWindowsLoggedOn(
  profileId: number,
  date: string
): Set<FoodSlot> {
  const rows = db
    .prepare(
      `SELECT recorded_at, meal_slot, occurred_at
         FROM food_log_events
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .all(profileId, date, PROTEIN_NUDGE_KEY) as Pick<
    FoodLedgerEvent,
    "recorded_at" | "meal_slot" | "occurred_at"
  >[];
  if (rows.length === 0) return new Set();
  const boundaries = profileFoodSlotBoundaries(profileId);
  const tz = getTimezone(profileId);
  return new Set(
    rows.map((row) =>
      foodEventWindow(
        row.recorded_at,
        tz,
        boundaries,
        row.meal_slot,
        row.occurred_at
      )
    )
  );
}

// ---- Which windows a day's ledger actually derived (issue #2376) ----

// For each calendar date in [from, to], the set of food windows that derived AT LEAST
// ONE event, through the ONE existing precedence (`foodEventWindow`: explicit slot →
// occurred_at → tap instant). The empty-window notice reads this both for the day it is
// asking about and for the trailing days its habit gate is measured over, so the two
// halves can never be derived through different boundaries.
//
// EVERY event counts, including the reserved `__protein__` key — unlike the meal
// grouping above, which drops it because a shake is not a food-group serving and must
// not render as a mystery meal chip. Here the question is whether the ledger holds
// anything for the window, and `getMinutesSinceLastFoodLog`'s reasoning applies
// verbatim: a protein shake is eating, and a check that excluded it would be wrong in
// the one direction that matters — claiming nothing is logged when something is.
//
// A date with no events is simply ABSENT from the map. That is the shape the decision
// wants: a day nobody logged and a day from before the events ledger existed are
// indistinguishable, and neither is evidence of anything. Profile-scoped via the
// food_log_events filter.
export function getLoggedFoodWindows(
  profileId: number,
  from: string,
  to: string
): Map<string, Set<FoodSlot>> {
  const rows = db
    .prepare(
      `SELECT date, recorded_at, meal_slot, occurred_at
         FROM food_log_events
        WHERE profile_id = ? AND date >= ? AND date <= ?`
    )
    .all(profileId, from, to) as Pick<
    FoodLedgerEvent,
    "date" | "recorded_at" | "meal_slot" | "occurred_at"
  >[];
  const boundaries = profileFoodSlotBoundaries(profileId);
  const tz = getTimezone(profileId);
  const byDate = new Map<string, Set<FoodSlot>>();
  for (const row of rows) {
    const slot = foodEventWindow(
      row.recorded_at,
      tz,
      boundaries,
      row.meal_slot,
      row.occurred_at
    );
    let set = byDate.get(row.date);
    if (!set) byDate.set(row.date, (set = new Set()));
    set.add(slot);
  }
  return byDate;
}

// ---- The live food-ledger check behind a dose's declared timing (issue #2022) ----

// Minutes since the profile's most recent logged serving, or null when the ledger holds
// none within the lookback window. The ONE ledger read behind the dose reminder's
// food-timing clause (lib/food-timing-check.ts owns what to say about it).
//
// THE EATING INSTANT WINS OVER THE TAP STAMP. `occurred_at` is a stated or tap-contracted
// measurement of when the food actually went in (#2019); `recorded_at` is when the button
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
      `SELECT MAX(COALESCE(occurred_at, recorded_at)) AS ate
         FROM food_log_events
        WHERE profile_id = ? AND COALESCE(occurred_at, recorded_at) >= ?`
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
// the LEDGER still justifies. Chat correction bursts carry chat taps only (#4356):
// page and offline rows keep their correction home on the surface that wrote them;
// Profile-scoped via the food_log_events filter.
export function getRecentFoodTaps(
  profileId: number,
  now: Date = clockNow()
): FoodTapRow[] {
  const since = utcInstant(
    new Date(now.getTime() - CORRECTION_FRESH_MIN * 60_000)
  );
  const rows = db
    .prepare(
      `SELECT id, group_key, recorded_at, occurred_at, notify_message_id, bundle_id
         FROM food_log_events
        WHERE profile_id = ? AND recorded_at >= ?
          AND (logged_via IS NULL OR logged_via IN ('telegram-nudge', 'telegram-command'))
        ORDER BY recorded_at, id
        LIMIT 100`
    )
    .all(profileId, since) as {
    id: number;
    group_key: string;
    recorded_at: string;
    occurred_at: string | null;
    notify_message_id: number | null;
    bundle_id: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    groupKey: r.group_key,
    tapAt: r.recorded_at,
    // Where the row STANDS (#2206): the chips count back from it and the row's header
    // states it, so a corrected serving stops being displayed at its tap time and a
    // second chip tap composes onto the first. Read regardless of `time_source` — the
    // question is what the ledger holds, not who put it there.
    statedAt: r.occurred_at,
    // Which message's tap wrote the row (#2264) — the burst's attribution, so a
    // correction row renders only on the message that produced it.
    messageRef: r.notify_message_id,
    bundleId: r.bundle_id,
    // The reserved __protein__ pseudo-group has no catalog entry, so it is named for
    // what it is rather than rendered as a mystery slug.
    label: isProteinNudgeKey(r.group_key)
      ? "Protein"
      : (foodGroupBySlug(r.group_key)?.name ?? r.group_key),
  }));
}

// `getFoodCorrectionBursts` — the taps-to-bursts pairing — lived here until #3330 moved
// its chat callers onto a consent-filtered wrapper. That wrapper is gone again: alcohol
// rides the food nudge under the food-buttons consent like any other group (owner
// ruling 2026-09-02), so every chat surface pairs bursts from `getRecentFoodTaps`
// directly and there is nothing left to filter between the ledger and the message.

// ---- Food-habit N-week consistency trend (issue #954) ----

// The trailing-N-week consistency strip for each tracked food-group habit, keyed by
// frequency_target id. Extends the SAME weekly rollup the this-week progress uses
// (getFrequencyTargetProgress's food_group branch — SUM(servings) over the week
// window) across HABIT_TREND_WEEKS weeks, so the trend's current-week cell equals the
// this-week progress for the same fixture (#221). Week identity follows the profile's
// configured week (mode + start), the SAME definition frequencyPace uses — no second
// "week" (#223). Weeks before a target was created render not-applicable (honest cold
// start), never as misses. Profile-scoped via the frequency_targets + food_daily_totals
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
      `SELECT group_key, date, servings FROM food_daily_totals
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
