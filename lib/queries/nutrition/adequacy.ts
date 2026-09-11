// Nutrient ADEQUACY (issues #767, #824, #976, #1166, #2379, #2414, #2788) — one of
// the three submodules behind lib/queries/nutrition.ts. The protein and fiber gathers
// each surface formats ("one question, one computation"), the per-day and trailing
// reads, the macro/fiber day series, the fiber x GI panel, and the biomarker→food and
// curated-supplement suggestion reads adequacy feeds. Profile-scoped throughout.

import { db, today } from "../../db";
import { getCurrentFlaggedBiomarkers } from "../medical";
import {
  getIntakeSafetyContext,
  getIngestibleSafetyContext,
  getIntakeItems,
} from "../intake";
import {
  suggestCuratedSupplements,
  type CuratedSupplementSuggestion,
} from "../../supplement-suggest-curated";
import { weekWindowStart } from "../profile-week";
import {
  aggregatePeriod,
  dayPeriod,
  estimatedNutrientGrams,
  type NutrientDeclaration,
  type NutrientServing,
} from "../../nutrient-adequacy";
import { daysBetweenDateStr } from "../../date";
import { suggestFoods, type FoodSuggestion } from "../../food-suggest";
import {
  getMetricDailyTotals,
  getAdditiveMetricDailyTotalsBatch,
  getWeights,
  getLatestMetricValue,
} from "../metrics";
import {
  buildMacroFiberSeries,
  mergeProteinSources,
  type MacroFiberDay,
} from "../../nutrition-trends";
import { filterSeriesByRange } from "../../trends";
import type { DateRange } from "../../timeline-format";
import { bodyweightAsOf } from "../../bodyweight";
import {
  proteinIntake,
  proteinTarget,
  proteinTrailingAverage,
  proteinTrailingWindowStart,
  assessProteinAdequacy,
  PROTEIN_DECLARATION,
  type ProteinAdequacy,
  type ProteinDayParts,
  type ProteinToday,
  type ProteinTrailing,
} from "../../protein";
import {
  fiberIntake,
  fiberTarget,
  assessFiberAdequacy,
  fiberDoseDays,
  FIBER_DECLARATION,
  type FiberAdequacy,
} from "../../fiber";
import {
  buildFiberSymptomPanel,
  fiberSymptomPanelDates,
  type FiberSymptomPanel,
} from "../../fiber-symptom-panel";
import { getSymptomDaysInRange } from "../symptoms";
import {
  nutritionDayPosition,
  type NutrientPosition,
  type NutritionDayPosition,
} from "../../nutrition-day";
import {
  shortfallFoodSuggestion,
  type ShortfallFoodSuggestion,
} from "../../nutrition-food-suggestion";
import {
  getProfileSex,
  getProfileAge,
  getExcludedFoodGroups,
  getProteinGoalLevel,
} from "../../settings/profile-attrs";
import { rollupServings } from "../../food-daily-totals";
import {
  getFoodDailyServingTotals,
  getFoodServingsOnDate,
  getFoodDailyServingTotalsInRange,
} from "./ledger";

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

// Safety-screened CURATED supplement suggestions for the profile's currently-flagged
// biomarker families (issue #2378) — the twin of getFoodSuggestions above, and the ONE
// computation every surface that renders a curated supplement claim formats. No model
// call, so the same profile state yields the same suggestions on every run; a family the
// map doesn't cover simply isn't here and falls through to the AI route
// (lib/supplement-suggest.ts). Empty when nothing covered is flagged on its entry's
// declared trigger side (#2754).
export function getCuratedSupplementSuggestions(
  profileId: number
): CuratedSupplementSuggestion[] {
  const flagged = getCurrentFlaggedBiomarkers(profileId).map((r) => ({
    name: r.name,
    flag: r.flag,
  }));
  if (flagged.length === 0) return [];

  // The INGESTIBLE-conservative safety gather (#691/#2378): the same facts the AI
  // route's deterministic belt screens against, resolved allergies included — a
  // recommendation to swallow something is screened the same way whichever engine
  // produced it.
  const { allergens, medications, conditions, situations } =
    getIngestibleSafetyContext(profileId);

  return suggestCuratedSupplements({
    flagged,
    allergens,
    medications,
    conditions,
    situations,
    // Supplements and medications share intake_items, and either can already supply the
    // substance — so the "already taking it" screen reads the whole active stack.
    alreadyTaking: getIntakeItems(profileId)
      .filter((s) => s.active)
      .map((s) => s.name),
  });
}

// ---- Protein-grams quick-add (issue #824) ----

// A day's manually-logged protein grams (the Food-tab quick-add running total), or 0
// when the profile logged none that day. Profile-scoped.
export function getProteinDailyGrams(profileId: number, date: string): number {
  const row = db
    .prepare(
      `SELECT grams FROM protein_daily_totals WHERE profile_id = ? AND date = ?`
    )
    .get(profileId, date) as { grams: number } | undefined;
  return row?.grams ?? 0;
}

// The profile's protein_daily_totals rows on/after `since` (inclusive) — for the per-day logged
// average the adequacy gather sums into the floor. Profile-scoped.
export function getProteinDailyTotals(
  profileId: number,
  since: string
): { date: string; grams: number }[] {
  return db
    .prepare(
      `SELECT date, grams FROM protein_daily_totals
        WHERE profile_id = ? AND date >= ? AND grams > 0
        ORDER BY date DESC`
    )
    .all(profileId, since) as { date: string; grams: number }[];
}

// ---- Trends → Nutrition → Macros & fiber (issues #1166, #2414) ----

// The Macros & fiber chart's per-day series, windowed to the hub's shared range.
//
// The gather lives here rather than in the section so the composition is ONE thing the
// DB tier can assert: protein is the #2414 merge of BOTH its sources (a tracked
// `protein_g` total overrides, the Food tab's hand-logged `protein_daily_totals` grams fill the
// days it does not cover), carbs/fat/fiber are their tracked daily totals. Windowing is
// the #2258 §4 precondition of the chart's day-fill; "0000-01-01" is the open lower
// bound of an all-time range.
export function getMacroFiberDays(
  profileId: number,
  range: DateRange
): MacroFiberDay[] {
  const tracked = getAdditiveMetricDailyTotalsBatch(profileId, [
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
  ]);
  return filterSeriesByRange(
    buildMacroFiberSeries({
      protein: mergeProteinSources(
        tracked.get("protein_g")!,
        getProteinDailyTotals(profileId, range.from ?? "0000-01-01").map(
          (r) => ({ date: r.date, value: r.grams })
        ),
        today(profileId)
      ),
      carbs: tracked.get("carbs_g")!,
      fat: tracked.get("fat_g")!,
      fiber: tracked.get("fiber_g")!,
    }),
    range
  );
}

// ---- The window both nutrient gathers read the same way (#4485) ----

// A source's per-day mean over the DAYS THAT CARRY A VALUE, never over the window, so a
// partial week is not diluted by the days nobody logged. Every source here arrives as ONE
// value per day already — `protein_daily_totals` is UNIQUE(profile_id, date), the metric
// readers GROUP BY date, and fiber doses come folded by `fiberDoseDays` — so the count of
// values IS the count of days. Null when nothing carries one: unknown, never 0.
function dailyMean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, v) => sum + v, 0) / values.length;
}

// The halves BOTH week gathers used to spell out identically: the profile's week window,
// the food-group estimated floor averaged over the days actually logged, the integration's
// daily totals averaged over the days that carry a reading, and the WEEK-TO-DATE period,
// which always ends on a today that is still accumulating (#4145 — a day-complete boolean
// is not a weekly model). The whole of the difference between the two gathers was the
// declaration's catalog column, which names the metric key too.
function weekToDateSources<K extends string>(
  profileId: number,
  declaration: NutrientDeclaration<K>
) {
  const weekStart = weekWindowStart(profileId);
  const entries = getFoodDailyServingTotals(profileId, weekStart);
  const loggedDays = new Set(entries.map((e) => e.date)).size;
  return {
    weekStart,
    period: aggregatePeriod(
      (daysBetweenDateStr(weekStart, today(profileId)) ?? 0) + 1,
      true
    ),
    dailyEstimated:
      loggedDays > 0
        ? estimatedNutrientGrams(rollupServings(entries), declaration.column) /
          loggedDays
        : 0,
    dailyTracked: dailyMean(
      getMetricDailyTotals(profileId, declaration.column)
        .filter((r) => r.date >= weekStart)
        .map((r) => r.value)
    ),
  };
}

// The same halves for ONE calendar day, which the two day-picker gathers also spelled out
// twice. A historical day is composed from its own servings and its own tracked reading,
// never from the current week's figures.
function onDateSources<K extends string>(
  profileId: number,
  declaration: NutrientDeclaration<K>,
  date: string
) {
  const servings = [...getFoodServingsOnDate(profileId, date).entries()].map(
    ([slug, n]) => ({ slug, servings: n })
  );
  return {
    period: dayPeriod(date, today(profileId)),
    dailyEstimated: estimatedNutrientGrams(servings, declaration.column),
    dailyTracked:
      getMetricDailyTotals(profileId, declaration.column).find(
        (r) => r.date === date
      )?.value ?? null,
  };
}

// ---- Protein adequacy (issue #767, #824) ----

// The ONE gather behind the /nutrition protein-adequacy card AND the coaching-tier
// adequacy finding (buildProteinAdequacyFindings). It assembles the pure engine's typed
// inputs from PROFILE-SCOPED reads and returns the pure verdict, so the card and the
// finding are formatters over the same result ("one question, one computation"). Reads
// through getFoodDailyServingTotals / getProteinDailyTotals / getMetricDailyTotals / getWeights /
// getLatestMetricValue, all profile-scoped, so the profile-scoping guard is satisfied.
// Returns null when there's no intake signal or no bodyweight to scale by.
//
// Windowing is `weekToDateSources` (#4485) — the same week the servings rollup uses, so
// the card's "this week" numbers line up, and the same per-source mean over the days that
// carry a value, so a partial week isn't diluted by unlogged days. Only the quick-add
// LOGGED floor is protein's own, because no other nutrient has that source.
export function getProteinAdequacy(profileId: number): ProteinAdequacy | null {
  // The estimated floor, the tracked mean and the WEEK-TO-DATE period — a mean over the
  // profile's week so far, which always ends on a today that is still accumulating
  // (#4145 — a day-complete boolean is not a weekly model).
  const { weekStart, period, dailyEstimated, dailyTracked } = weekToDateSources(
    profileId,
    PROTEIN_DECLARATION
  );

  // Logged floor (#824): this week's quick-add protein grams, averaged over the days that
  // carry them, so a partial week isn't diluted by days with no manual entry. Summed with
  // the estimate in proteinIntake (a manual entry is a partial addition, never an eraser).
  const dailyLogged = dailyMean(
    getProteinDailyTotals(profileId, weekStart).map((r) => r.grams)
  );

  // Bodyweight (ascending for bodyweightAsOf) + latest lean mass (preferred when present).
  const weightsAsc = getWeights(profileId)
    .map((w) => ({ date: w.date, weight_kg: w.weight_kg }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const bodyweightKg = bodyweightAsOf(weightsAsc, today(profileId));
  const leanMassKg = getLatestMetricValue(profileId, "lean_mass_kg");

  // Goal level — the profile's training goal (Settings → Nutrition, #1503), or the
  // documented default when they have not picked one. ONE reader for every surface.
  const goal = getProteinGoalLevel(profileId);

  return assessProteinAdequacy(
    proteinIntake({ dailyTracked, dailyLogged, dailyEstimated, period }),
    proteinTarget({ goal, bodyweightKg, leanMassKg })
  );
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
  for (const e of getFoodDailyServingTotals(profileId, since)) {
    const list = estimatedByDate.get(e.date);
    const serving = { slug: e.group_key, servings: e.servings };
    if (list) list.push(serving);
    else estimatedByDate.set(e.date, [serving]);
  }

  const loggedByDate = new Map<string, number>();
  for (const r of getProteinDailyTotals(profileId, since)) {
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
    dailyEstimated: estimatedNutrientGrams(
      estimatedByDate.get(date) ?? [],
      PROTEIN_DECLARATION.column
    ),
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
      `SELECT 1 AS hit FROM food_daily_totals
         WHERE profile_id = ? AND date < ? AND servings > 0
       UNION ALL
       SELECT 1 AS hit FROM protein_daily_totals
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

// Whether the profile has EVER carried a protein signal — logged grams, a tracked
// reading, or the food servings the estimate is built from (#2328). The unbounded
// twin of the probe above, and deliberately NOT a window: "does this profile have
// protein data" is an existence question, and every window-shaped answer to it is
// wrong on the mornings before that window has been fed anything. Same three
// indexed probes, so the two can never disagree about what counts as a signal.
// Profile-scoped.
function hasAnyProteinSignal(profileId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM food_daily_totals
         WHERE profile_id = ? AND servings > 0
       UNION ALL
       SELECT 1 AS hit FROM protein_daily_totals
         WHERE profile_id = ? AND grams > 0
       UNION ALL
       SELECT 1 AS hit FROM metric_samples
         WHERE profile_id = ? AND metric = 'protein_g'
       LIMIT 1`
    )
    .get(profileId, profileId, profileId) as { hit: number } | undefined;
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

  const { period, dailyEstimated, dailyTracked } = onDateSources(
    profileId,
    PROTEIN_DECLARATION,
    date
  );
  const loggedOnDate = getProteinDailyGrams(profileId, date);
  const dayIntake = proteinIntake({
    dailyTracked,
    dailyLogged: loggedOnDate > 0 ? loggedOnDate : null,
    dailyEstimated,
    period,
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
export function getProteinToday(
  profileId: number,
  // WHICH DAY (#4118). Defaults to the profile's today, which is what every web caller
  // wants and what this function was named for. The Telegram food nudge passes the day
  // the MESSAGE is for: since the sweep may now rebuild a message up to two days old,
  // a `today()` resolved in here painted the CURRENT day's protein figure onto a past
  // day's nudge — beside a tally, a button count and a gap notice that were all
  // date-correct — and announced "goal reached" about a day on which it was not.
  date: string = today(profileId)
): ProteinToday | null {
  const t = date;
  const onDate = getProteinOnDate(profileId, t);

  // Weekly marker — EXACTLY the adequacy computation's daily-average figure (#221), read
  // from the SAME gather so the two can never disagree. WEEK-TO-DATE: it is the number
  // the weekly adequacy verdict is reached on, and the gauge's marker labels it as such.
  //
  // THE ONE FIELD `date` DOES NOT MOVE, stated rather than left to be discovered:
  // `getProteinAdequacy` is week-to-date as of NOW and has no dated form. No caller
  // passing a past `date` renders it — the food nudge reads only
  // `proteinTodayLineParts`, which uses `todayGrams` and `target` — so this is a
  // documented limit of the dated read and not a live wrong number. A future surface
  // that wants a past day's weekly marker has to date-resolve the adequacy gather.
  const weeklyAverageGrams =
    getProteinAdequacy(profileId)?.intake.grams ?? null;

  // …and the TRAILING 7-day average (#1917), a different question with its own
  // computation, for the surfaces that say "7-day average".
  const trailing = getProteinTrailing(profileId, t);

  if (onDate) return { ...onDate, weeklyAverageGrams, trailing };

  // Nothing logged on that day yet. Suppress only for a profile that has no protein data
  // AT ALL (a bodyweight-only profile that has never logged) — never a bare "0 g"
  // nudge or empty gauge for them.
  //
  // #2328: this used to test `weeklyAverageGrams`, which is the WEEK-TO-DATE average
  // — and week-to-date on the first day of the week is TODAY ALONE. So an established
  // logger with months of history got no gauge at all every week-start morning until
  // their first log, and the aggregate claimed "this profile has no protein data",
  // which was false. The evidence for the question the comment asks is an EXISTENCE
  // check, not a window: `hasAnyProteinSignal`. The trailing window (#1917) was the
  // near miss — it does not reset at the week boundary, but it is still a window, so
  // a logger with an eight-day gap would reproduce the same defect at a longer
  // horizon. (Its `dayOne` marker cannot stand in either: `dayOne` is only ever set
  // alongside a non-null `grams`, so "grams == null && dayOne" is unsatisfiable.)
  if (!hasAnyProteinSignal(profileId)) return null;
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
): {
  date: string;
  itemId: number;
  name: string;
  kind: "supplement" | "medication";
  brand: string | null;
  product: string | null;
  amount: string | null;
}[] {
  return db
    .prepare(
      `SELECT l.date AS date,
              s.id AS itemId,
              s.name AS name,
              s.kind AS kind,
              s.brand AS brand,
              s.product AS product,
              l.amount AS amount
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.date >= ? AND l.status = 'taken'
          AND l.item_id IS NOT NULL`
    )
    .all(profileId, since) as {
    date: string;
    itemId: number;
    name: string;
    kind: "supplement" | "medication";
    brand: string | null;
    product: string | null;
    amount: string | null;
  }[];
}

// The ONE gather behind the /nutrition fiber-adequacy card AND the coaching-tier fiber
// finding (buildFiberAdequacyFindings), with one source protein doesn't have
// (supplemented). It assembles the pure engine's typed inputs from PROFILE-SCOPED reads
// and returns the pure verdict, so the card and the finding are formatters over the same
// result ("one question, one computation"). Reads through getFoodDailyServingTotals /
// getConfirmedIntakeDosesInRange / getMetricDailyTotals, all profile-scoped, so the
// scoping guard is satisfied. Returns null when there's no intake signal or no DRI target.
//
// NO LONGER "the protein gather re-instantiated" (#4485): the window, the estimated floor
// and the tracked mean are the SAME `weekToDateSources` protein reads, differing only by
// the declaration handed to it. `fiberIntake` compares the tracked mean with the sum of
// the estimated and supplemented means; it does not add the independent sources.
export function getFiberAdequacy(profileId: number): FiberAdequacy | null {
  const { weekStart, period, dailyEstimated, dailyTracked } = weekToDateSources(
    profileId,
    FIBER_DECLARATION
  );

  // Supplemented floor: this week's CONFIRMED fiber doses, averaged over the days with a
  // KNOWN-gram dose (a capsule/unknown-unit dose raises the caveat but isn't in the
  // divisor). Snapshot amounts; a skipped dose is already excluded by the query.
  const doses = fiberDoseDays(
    getConfirmedIntakeDosesInRange(profileId, weekStart)
  );

  return assessFiberAdequacy(
    fiberIntake({
      dailyTracked,
      dailyEstimated,
      dailySupplemented: dailyMean([...doses.gramsByDate.values()]),
      unknownSupplement: doses.unknownDates.size > 0,
      period,
    }),
    fiberTarget({
      ageYears: getProfileAge(profileId),
      sex: getProfileSex(profileId),
    })
  );
}

// A SINGLE calendar day's fiber estimate for the seven-day Food picker. Unlike
// getFiberAdequacy's current-week daily average, this combines only the selected day's
// food servings, confirmed fiber doses, and tracked fiber total. That keeps Yesterday's
// display historical rather than silently repeating this week's figure.
export function getFiberOnDate(
  profileId: number,
  date: string
): FiberAdequacy | null {
  const { period, dailyEstimated, dailyTracked } = onDateSources(
    profileId,
    FIBER_DECLARATION,
    date
  );
  // The ranged read starts at `date`, so a later day's doses can be in it — and they do
  // not need filtering out, because `fiberDoseDays` keys both of its answers BY DAY and
  // this reads only `date`. The narrowing is the lookup, not a second pass.
  const doses = fiberDoseDays(getConfirmedIntakeDosesInRange(profileId, date));
  const dailySupplemented = doses.gramsByDate.get(date) ?? 0;

  return assessFiberAdequacy(
    fiberIntake({
      dailyTracked,
      dailyEstimated,
      dailySupplemented: dailySupplemented > 0 ? dailySupplemented : null,
      unknownSupplement: doses.unknownDates.has(date),
      period,
    }),
    fiberTarget({
      ageYears: getProfileAge(profileId),
      sex: getProfileSex(profileId),
    })
  );
}

// ---- Fiber × GI symptoms, read together (issue #2788) ----

// The read-together gather: the daily fiber series (#976) and the window's symptom
// days (the same rollup reader the timeline reads), assembled by the pure panel
// module. A VIEW's input — no derivation of its own, no finding, no send; the window,
// the GI filter, and every shape decision live in lib/fiber-symptom-panel.ts (this
// gather holds no window arithmetic, #1909).
//
// THREE RANGED READS, not a per-day getFiberOnDate loop: each getFiberOnDate call
// re-aggregates the profile's whole fiber_g history and runs an open-ended dose scan,
// so 28 of them per render is an N+1 the page pays on every visit. The per-day figure
// still comes from the SAME pure pieces the picker's gather composes
// (estimatedNutrientGrams / fiberDoseDays / fiberIntake), so the
// two surfaces cannot disagree about a day — and the panel deliberately skips the
// TARGET half (fiberTarget/assessFiberAdequacy): it draws intake, not adequacy.
export function getFiberSymptomPanel(profileId: number): FiberSymptomPanel {
  const todayStr = today(profileId);
  const dates = fiberSymptomPanelDates(todayStr);
  const from = dates[0];
  const to = dates[dates.length - 1];

  // Servings per day, from the shared ranged reader. A day PRESENT here with only
  // zero-fiber groups is an honest 0 g, distinct from an unlogged day's null (#2258).
  const servingsByDate = new Map<string, NutrientServing[]>();
  for (const r of getFoodDailyServingTotalsInRange(profileId, from, to)) {
    const list = servingsByDate.get(r.date) ?? [];
    list.push({ slug: r.group_key, servings: r.servings });
    servingsByDate.set(r.date, list);
  }

  // Confirmed fiber doses per day — known grams summed; an unknown-unit dose flags the
  // day (the caveat the panel must carry rather than claiming "0 g"). The SAME scan the
  // week gather and the day picker read, windowed to the panel's range here.
  const { gramsByDate: suppGramsByDate, unknownDates: unknownSupplementDates } =
    fiberDoseDays(
      getConfirmedIntakeDosesInRange(profileId, from).filter(
        (r) => r.date <= to
      )
    );

  // Tracked fiber_g daily totals, once, as a date → value map.
  const trackedByDate = new Map(
    getMetricDailyTotals(profileId, "fiber_g").map((r) => [r.date, r.value])
  );

  const gramsByDate = new Map<string, number | null>();
  for (const date of dates) {
    const servings = servingsByDate.get(date);
    const supplemented = suppGramsByDate.get(date) ?? null;
    const intake = fiberIntake({
      dailyTracked: trackedByDate.get(date) ?? null,
      dailyEstimated: servings
        ? estimatedNutrientGrams(servings, FIBER_DECLARATION.column)
        : 0,
      dailySupplemented: supplemented,
      unknownSupplement: unknownSupplementDates.has(date),
      period: dayPeriod(date, todayStr),
    });
    // fiberIntake refuses a zero-signal day (null); a day that LOGGED only
    // zero-fiber groups upgrades to an honest 0.
    gramsByDate.set(
      date,
      intake ? intake.grams : servingsByDate.has(date) ? 0 : null
    );
  }

  const symptoms = getSymptomDaysInRange(profileId, from, to).flatMap((day) =>
    day.symptoms.map((s) => ({
      date: day.date,
      symptom: s.symptom,
      severity: s.severity,
    }))
  );

  return buildFiberSymptomPanel({
    dates,
    gramsByDate,
    unknownSupplementDates,
    symptoms,
  });
}

// ---- One day, both nutrients (issue #2379) ----

// "Where did ONE day's eating land against its protein and fibre targets?" — the single
// gather behind the morning digest's nutrition line and, by #2383, the curated-food
// follow-up sized from the same shortfall.
//
// IT ASSEMBLES, IT DOES NOT DECIDE. Both verdicts come from the per-day gathers the
// /nutrition day picker already reads (`getProteinOnDate` + `assessProteinAdequacy`,
// `getFiberOnDate`), so the digest and the page state one day's position from one
// computation (#221). The composition, the gap and the copy are pure in
// `lib/nutrition-day.ts`. No new SQL, no new threshold, no second adequacy rule.
//
// PROTEIN'S TARGET IS RESOLVED AS OF THAT DAY (`getProteinOnDate` → `proteinTargetOnDate`),
// so a weigh-in recorded since cannot leak backward into a claim about a past day.
//
// Returns null when NEITHER nutrient can be positioned: a day with no food logged, or a
// profile with no bodyweight to scale a protein band by and no quantified fibre. Absence
// of logging is not evidence of low intake, so it produces silence rather than a zero.
export function getNutritionDay(
  profileId: number,
  date: string
): NutritionDayPosition | null {
  const proteinDay = getProteinOnDate(profileId, date);
  return nutritionDayPosition({
    date,
    protein: proteinDay?.todayIntake
      ? assessProteinAdequacy(proteinDay.todayIntake, proteinDay.target)
      : null,
    fiber: getFiberOnDate(profileId, date),
  });
}

// The curated food group offered against those shortfalls (issue #2383), or null.
//
// TAKES THE SHORTFALLS, DOES NOT RE-READ THE DAY. The caller has already resolved the
// position (`getNutritionDay` → `nutritionShortfalls`) to decide whether there is a line
// at all; gathering it a second time here would pay for the day's food, dose and metric
// reads twice and let the offer disagree with the figures it rides beside.
//
// The safety facts come from `getIntakeSafetyContext` — the SAME shared gather (#661) the
// biomarker food route and the AI supplement belt screen against, so a food suggested for
// a missed target and one suggested for a flagged lab cannot disagree about the profile's
// allergies, stack or conditions. Dietary preferences (#975) ride along as the softer
// filter they are.
//
// Returns null the moment there is nothing to offer, which is most days. The decision is
// pure and lives in `shortfallFoodSuggestion`; this only assembles its inputs.
export function getShortfallFoodSuggestion(
  profileId: number,
  shortfalls: readonly NutrientPosition[]
): ShortfallFoodSuggestion | null {
  if (shortfalls.length === 0) return null;
  const { allergens, medications, conditions, situations } =
    getIntakeSafetyContext(profileId);
  return shortfallFoodSuggestion(shortfalls, {
    allergens,
    medications,
    conditions,
    situations,
    excludedGroups: getExcludedFoodGroups(profileId),
  });
}
