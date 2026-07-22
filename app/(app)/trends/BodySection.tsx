import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { chartSeries } from "@/lib/chart-colors";
import { formatHm, sleepRecordPresentation } from "@/lib/sleep-summary";
import { sriPresentation } from "@/lib/sleep-regularity";
import {
  getUnitPrefs,
  getDisplayFormatPrefs,
  getUserSex,
  getUserBirthdate,
  getUserAge,
} from "@/lib/settings";
import { ageInMonthsFromBirthdate, shiftDateStr } from "@/lib/date";
import {
  planBodyCharts,
  showGrowthQuickAdd,
  showHeadCircEntry,
  showBodyFat,
  type BodyChartKey,
} from "@/lib/growth-metrics";
import {
  getBodyMetricDailySeries,
  getBodyMetricsWithSource,
  getMetricDailyTotals,
  getSleepRegularity,
  getLastNightSummary,
  getHrDailySummary,
  getLatestHrDay,
  getHrMinutes,
  getGoals,
  getMoodLogs,
} from "@/lib/queries";
import { dispWeight, fmtWeight, round } from "@/lib/units";
import {
  buildGrowthProfile,
  bmiSeriesDatePaired,
  displayWeightGrowth,
} from "@/lib/growth-series";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { orderBodyCharts } from "@/lib/trends-body-order";
import {
  BODY_METRIC_META,
  buildBodyMetricTile,
  type BodyMetricSlug,
  type BodyMetricTile,
} from "@/lib/trends-body-metrics";
import {
  buildTrendAnnotations,
  buildProtocolTrendWindows,
} from "@/lib/trends-series";
import { projectGoal, describeEta } from "@/lib/trend-projection";
import { formatLongDate, formatClockMinutes } from "@/lib/format-date";
import { isGoalLive } from "@/lib/goals";
import type { BodyMetricKind, Goal } from "@/lib/types";
import type { AppRoute } from "@/lib/hrefs";
import type { DateRange } from "@/lib/timeline-format";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import NotesText from "@/components/NotesText";
import StackedBarCard from "@/components/StackedBarCard";
import ScrollFade from "@/components/ScrollFade";
import BodyTrendCharts, {
  type BodyChartSpec,
} from "@/components/BodyTrendCharts";
import GrowthChartsCard, {
  type GrowthMetricView,
} from "@/components/GrowthChartsCard";
import BodyQuickAdd from "./BodyQuickAdd";
import VitalsQuickAdd from "./VitalsQuickAdd";
import GrowthQuickAdd from "./GrowthQuickAdd";
import QuickAddPanel, { type QuickAddItem } from "./QuickAddPanel";
import ChartJumpChips, { type ChartChip } from "./ChartJumpChips";
import BodyMetricTiles from "./BodyMetricTiles";
import BodyViewToggle from "./BodyViewToggle";
import {
  tilesContainerClass,
  stackContainerClass,
  type BodyView,
} from "./body-view";
import DeleteBodyMetricButton from "./DeleteBodyMetricButton";
import EditLockNotice from "@/components/EditLockNotice";
import BodyHygieneFindings from "./BodyHygieneFindings";
import SourceComparison from "./SourceComparison";

// The Trends hub's Body section: the full Body Metrics surface (absorbed here in
// the sidebar consolidation — the standalone /body-metrics page was retired and
// redirects to /trends?tab=body). It carries the compact logging quick-add, the
// windowed weight / body-fat / resting-HR trend charts + goal overlays + growth
// card, the synced-from-integrations daily charts (steps, sleep, HR, body
// composition, intake), and the full history/provenance table with per-row
// delete. Weight respects the login's unit preference (dispWeight). Reuses the
// body-metrics queries/actions and the existing chart components; this tab is NOT
// age-gated, so every profile reaches it (matching the old page).
export default async function BodySection({
  range,
  view,
  tilesHref,
  allHref,
}: {
  range: DateRange;
  // #1067 Phase 2: the overview layout mode (undefined → tiles on mobile, the
  // classic stack on desktop; "tiles"/"all" pin one on every viewport).
  view: BodyView;
  tilesHref: AppRoute;
  allHref: AppRoute;
}) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const todayStr = today(profile.id);
  const wu = units.weightUnit;

  // Read the whole series (ALL_ROWS overrides the default 365-row cap) so an
  // older window isn't silently truncated before filterSeriesByRange windows it.
  // The chart series read one value per day through getBodyMetricDailySeries
  // (issue #14): when several sources report the same day, the profile's primary
  // source (else the default preference) wins, so a two-device day doesn't
  // zig-zag the trend. The history table below keeps every row (all sources).
  const weightSeries = getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS);
  const bodyMetrics = getBodyMetricsWithSource(profile.id, ALL_ROWS);

  // #1067 Phase 2: keep the UNWINDOWED display-unit series named (…All) so the
  // overview tiles read their 30-day tail from the SAME arrays the windowed charts
  // draw — one gather feeds both (#221). The chart applies the shared range on top.
  const weightAll = weightSeries.map((w) => ({
    date: w.date,
    value: dispWeight(w.value, wu),
  }));
  const weightChart = filterSeriesByRange(weightAll, range);
  const bodyFatAll = getBodyMetricDailySeries(
    profile.id,
    "body_fat",
    ALL_ROWS
  ).map((w) => ({ date: w.date, value: round(w.value, 1) }));
  const bodyFatChart = filterSeriesByRange(bodyFatAll, range);
  const restingHrAll = getBodyMetricDailySeries(
    profile.id,
    "resting_hr",
    ALL_ROWS
  ).map((w) => ({ date: w.date, value: Math.round(w.value) }));
  const restingHrChart = filterSeriesByRange(restingHrAll, range);

  // Age drives an age-aware Body-tab layout (kids growth trends): for a child,
  // HEIGHT is the priority datapoint and body fat % is not tracked, so the tab
  // charts height (and head circ for the very young), drops body fat, floats the
  // growth-percentile card to the top, and offers a height/head-circ quick-add.
  // Adults keep the original weight → body fat → resting-HR layout unchanged. The
  // decision is the pure lib/growth-metrics (planBodyCharts), shared with tests.
  const ageYears = getUserAge(profile.id);
  const birthdate = getUserBirthdate(profile.id);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, today(profile.id))
    : null;
  const plan = planBodyCharts({ ageYears, ageMonths });
  // Body fat % is de-prioritized for a growth-tracked profile. #493: apply the ONE
  // showBodyFat predicate at EVERY interactive surface — the charts (via plan.keys),
  // the entry field, and the history column — so "not tracked" is consistent instead
  // of hidden-from-charts-but-still-enterable. (The raw data export keeps the column,
  // a complete-record contract distinct from this display choice.)
  const bodyFatShown = showBodyFat(ageYears);

  // Height + head-circumference series (canonical cm, from metric_samples — the
  // same store the growth charts read). Charted on the Body tab for minors so a
  // height/head-circ history always surfaces even without the full growth card.
  // Read the WHOLE series (ALL_ROWS) before windowing (issue #399): the default
  // 180-row cap in getMetricDailyTotals hides an older window entirely — Health
  // Connect syncs height on every export, so ~daily samples fill 180 rows in ~6
  // months and last year's window rendered an empty "no data" chart that lied.
  const heightAll = getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map(
    (r) => ({ date: r.date, value: round(r.value, 1) })
  );
  const heightChart = filterSeriesByRange(heightAll, range);
  const headCircAll = getMetricDailyTotals(
    profile.id,
    "head_circumference_cm",
    ALL_ROWS
  ).map((r) => ({ date: r.date, value: round(r.value, 1) }));
  const headCircChart = filterSeriesByRange(headCircAll, range);

  // Event annotations (medication start/stop, appointments, situation changes)
  // windowed to the shared range — the same set drives all three charts via the
  // one toggle bar. Reads only through profile-scoped queries (buildTrendAnnotations).
  const annotations = buildTrendAnnotations(profile.id, range);
  // Protocol intervention windows (issue #660), shaded across the body charts via
  // the same toggle bar as the point annotations.
  const protocolWindows = buildProtocolTrendWindows(profile.id, range);

  // Goal projection: for a body-metric goal with a target value +
  // target_date, draw the target line and extrapolate the windowed trend to it.
  // Weight targets are stored canonically (kg) → convert to the display unit so the
  // line and the projection math share the chart's unit. First active, non-archived
  // goal per metric wins (getGoals returns active-first).
  const goals = getGoals(profile.id);
  const goalFor = (metric: BodyMetricKind): Goal | undefined =>
    goals.find(
      (g) => g.body_metric === metric && isGoalLive(g) && g.target_value != null
    );

  const goalOverlay = (
    metric: BodyMetricKind,
    data: { date: string; value: number }[],
    unit: string,
    decimals: number
  ): Pick<BodyChartSpec, "referenceValue" | "projectionNote"> => {
    const goal = goalFor(metric);
    if (!goal || goal.target_value == null) {
      return { referenceValue: null, projectionNote: null };
    }
    const toDisplay = (v: number) =>
      metric === "weight" ? dispWeight(v, wu) : round(v, decimals);
    const target = toDisplay(goal.target_value);
    const baseline =
      goal.baseline_value == null ? null : toDisplay(goal.baseline_value);
    const targetLabel = `Goal ${round(target, decimals)}${unit}`;
    const projection = projectGoal(data, target, goal.target_date, baseline);
    let projectionNote: string | null = null;
    if (projection?.status === "away") {
      projectionNote = `Currently trending away from your ${round(target, decimals)}${unit} goal.`;
    } else if (projection?.status === "reaching") {
      const reach = `At current pace you reach ${round(target, decimals)}${unit}`;
      projectionNote =
        projection.daysEarly != null
          ? `${reach} ${describeEta(projection.daysEarly)}.`
          : `${reach} around ${projection.projectedDate}.`;
    }
    // Hedge a shaky projection (few points / scattered trend) so the ETA doesn't
    // read as precise (#37).
    if (projectionNote && projection?.confidence === "low") {
      projectionNote += " (rough estimate)";
    }
    return {
      referenceValue: { value: target, label: targetLabel },
      projectionNote,
    };
  };

  // The full set of body-composition chart specs, keyed so the age-aware plan can
  // order/select them. For a minor, body fat is absent from plan.keys entirely.
  const chartByKey: Record<BodyChartKey, BodyChartSpec> = {
    height: {
      key: "height",
      title: "Height",
      data: heightChart,
      label: "Height",
      unit: " cm",
      color: chartSeries.violet,
    },
    head_circumference: {
      key: "head_circumference",
      title: "Head circumference",
      data: headCircChart,
      label: "Head circ.",
      unit: " cm",
      color: chartSeries.emerald,
    },
    weight: {
      key: "weight",
      title: "Weight",
      data: weightChart,
      label: "Weight",
      unit: ` ${wu}`,
      color: chartSeries.brand,
      ...goalOverlay("weight", weightChart, ` ${wu}`, 1),
    },
    bodyfat: {
      key: "bodyfat",
      title: "Body fat",
      data: bodyFatChart,
      label: "Body fat",
      unit: "%",
      color: chartSeries.violet,
      ...goalOverlay("body_fat", bodyFatChart, "%", 1),
    },
    resting_hr: {
      key: "resting_hr",
      title: "Resting heart rate",
      data: restingHrChart,
      label: "Resting HR",
      unit: " bpm",
      color: chartSeries.amber,
      ...goalOverlay("resting_hr", restingHrChart, " bpm", 0),
    },
  };
  const charts: BodyChartSpec[] = plan.keys.map((k) => chartByKey[k]);

  // Pediatric growth percentiles — reuses the exact build the Body Metrics page
  // uses; returns null unless the profile has a known sex + birthdate and is in
  // chart range. Age-based, so it isn't windowed by the shared range.
  // The growth card plots the child's WHOLE trajectory (each measurement at the age
  // it was taken), so its inputs must be unbounded (ALL_ROWS) — the default 180-row
  // cap silently started the percentile track ~6 months ago on a daily-synced
  // child, losing the entire earlier arc that is the chart's whole point (#399).
  // weightSeries is already read with ALL_ROWS above.
  const growth = buildGrowthProfile({
    sex: getUserSex(profile.id),
    birthdate: getUserBirthdate(profile.id),
    today: today(profile.id),
    heights: getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map(
      (r) => ({
        date: r.date,
        value: r.value,
      })
    ),
    weights: weightSeries.map((w) => ({ date: w.date, value: w.value })),
    headCircs: getMetricDailyTotals(
      profile.id,
      "head_circumference_cm",
      ALL_ROWS
    ).map((r) => ({ date: r.date, value: r.value })),
  });
  const growthMeta: Record<
    "height" | "weight" | "bmi" | "head_circumference",
    { label: string; unit: string; valueRound: number }
  > = {
    height: { label: "Height", unit: " cm", valueRound: 1 },
    // Weight's unit follows the login's weight preference — the plotted values
    // are converted at the display boundary below (displayWeightGrowth).
    weight: { label: "Weight", unit: ` ${wu}`, valueRound: 1 },
    bmi: { label: "BMI", unit: "", valueRound: 1 },
    head_circumference: { label: "Head circ.", unit: " cm", valueRound: 1 },
  };
  const growthViews: GrowthMetricView[] = growth
    ? growth.metrics
        .filter((m) => m.bands.length > 0 && m.points.length > 0)
        .map((m) => {
          // Percentiles stay computed in kg (correct); only the DISPLAYED plot +
          // label change for an lb-preference user. For weight, convert the
          // reference bands AND the trajectory points together so they stay
          // coherent (converting only the points would break the plot). Other
          // metrics (height / BMI / head circ) are unit-invariant here.
          const plot =
            m.metric === "weight"
              ? displayWeightGrowth(m, wu)
              : { bands: m.bands, points: m.points };
          return {
            metric: m.metric,
            ...growthMeta[m.metric],
            bands: plot.bands,
            points: plot.points,
            latestPercentile: m.latest?.percentile ?? null,
            minMonths: m.minMonths,
            maxMonths: m.maxMonths,
          };
        })
    : [];
  const growthSource = growth && growth.ageMonths < 24 ? "WHO" : "CDC";
  const growthCard =
    growth && growthViews.length > 0 ? (
      <GrowthChartsCard
        views={growthViews}
        currentAgeMonths={growth.ageMonths}
        source={growthSource}
      />
    ) : null;

  // Synced-from-integrations daily metrics (steps, sleep, body composition,
  // intake, heart rate). These are NOT windowed by the shared range; they show the
  // most recent ~6 months (the queries' default 180-row cap), captioned honestly
  // below (issue #399 — no silent caps) rather than claiming a full series.
  const stepsChart = getMetricDailyTotals(profile.id, "steps").map((r) => ({
    date: r.date,
    value: Math.round(r.value),
  }));
  // Sleep moved to its own dedicated /sleep page (issue #1066): the detailed
  // per-night / regularity / stage cards live there now. Trends → Body keeps a
  // COMPACT summary tile (the all-metrics skim keeps a sleep presence, not
  // deleted) — last night's main-session duration + the SRI — linking to /sleep.
  // Both figures come from the SAME computations the Sleep page reads.
  const lastNight = getLastNightSummary(profile.id);
  const lastNightPresentation = lastNight
    ? sleepRecordPresentation(lastNight.wakeDay, todayStr, formatPrefs)
    : null;
  const visibleLastNight =
    lastNightPresentation?.freshness === "stale" ? null : lastNight;
  const sleepReg = getSleepRegularity(profile.id);
  const hasSleep = visibleLastNight != null || sleepReg != null;
  const leanMassChart = getMetricDailyTotals(profile.id, "lean_mass_kg").map(
    (r) => ({ date: r.date, value: round(r.value, 1) })
  );
  const boneMassChart = getMetricDailyTotals(profile.id, "bone_mass_kg").map(
    (r) => ({ date: r.date, value: round(r.value, 2) })
  );
  const bmrChart = getMetricDailyTotals(profile.id, "bmr_kcal").map((r) => ({
    date: r.date,
    value: Math.round(r.value),
  }));
  const hydrationChart = getMetricDailyTotals(profile.id, "hydration_l").map(
    (r) => ({ date: r.date, value: round(r.value, 2) })
  );
  const caloriesChart = getMetricDailyTotals(profile.id, "nutrition_kcal").map(
    (r) => ({ date: r.date, value: Math.round(r.value) })
  );
  const protein = new Map(
    getMetricDailyTotals(profile.id, "protein_g").map((r) => [r.date, r.value])
  );
  const carbs = new Map(
    getMetricDailyTotals(profile.id, "carbs_g").map((r) => [r.date, r.value])
  );
  const fat = new Map(
    getMetricDailyTotals(profile.id, "fat_g").map((r) => [r.date, r.value])
  );
  const macroDates = [
    ...new Set([...protein.keys(), ...carbs.keys(), ...fat.keys()]),
  ].sort();
  const macrosChart = macroDates.map((d) => ({
    date: d.slice(5),
    protein: round(protein.get(d) ?? 0, 0),
    carbs: round(carbs.get(d) ?? 0, 0),
    fat: round(fat.get(d) ?? 0, 0),
  }));
  // BMI over the weight series, pairing each weigh-in with the height in effect
  // ON OR BEFORE that date — the SAME date-paired derivation the growth card uses
  // (bmiSeriesDatePaired), so the two BMI charts on a child's Body tab can't
  // disagree (issue #407). Applying a single "most recent height" backward
  // inflated early history for a growing child; adults degrade gracefully (height
  // rarely changes). Reads the whole height series (ALL_ROWS) so an older weigh-in
  // still finds its contemporaneous height.
  const bmiChart = bmiSeriesDatePaired(
    weightSeries.map((w) => ({ date: w.date, value: w.value })),
    getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map((r) => ({
      date: r.date,
      value: r.value,
    }))
  ).map((p) => ({ date: p.date, value: round(p.value, 1) }));
  // Mood trend (#992): the daily wellbeing check-ins as a chartable 1–5 series —
  // like a vital in shape, but DELIBERATELY never reference-range flagged and never
  // retested (a subjective self-rating, not a lab; pinned by the mood-guardrails
  // test). Most recent ~6 months, matching the synced-metrics cap.
  const moodChart = getMoodLogs(
    profile.id,
    shiftDateStr(today(profile.id), -179)
  ).map((m) => ({ date: m.date, value: m.valence }));

  const hrChart = getHrDailySummary(profile.id).map((r) => ({
    date: r.date,
    value: Math.round(r.avg),
  }));
  const latestHrDay = getLatestHrDay(profile.id);
  const hrIntraday = latestHrDay
    ? getHrMinutes(profile.id, latestHrDay).map((m) => ({
        date: m.ts.slice(11), // HH:MM
        value: round(m.bpm, 0),
      }))
    : [];
  const hasSynced =
    stepsChart.length > 0 ||
    hasSleep ||
    hrChart.length > 0 ||
    leanMassChart.length > 0 ||
    boneMassChart.length > 0 ||
    bmrChart.length > 0 ||
    hydrationChart.length > 0 ||
    caloriesChart.length > 0 ||
    macrosChart.length > 0 ||
    bmiChart.length > 0;

  // #1067 Phase 1: order the synced daily charts by relevance (present + recent
  // ahead of the fixed order) and render BOTH the sticky jump chips and the chart
  // cards from the SAME visible list, so a chip can never point at an absent chart.
  // `scroll-mt` clears the sticky mobile header + chip row so a `#id` anchor lands
  // ON the chart, not under the chrome. Each card carries its `id` for the anchor.
  const lastDateOf = (arr: { date: string }[]): string | null =>
    arr.length > 0 ? arr[arr.length - 1].date : null;
  const anchorClass = "card scroll-mt-28";

  // Descriptor list for the synced grid. `order` is the historical base sequence;
  // `present` is the ONE has-data gate driving chip + chart together.
  const syncedEntries: (ChartChip & {
    present: boolean;
    latestDate: string | null;
    order: number;
    node: React.ReactNode;
  })[] = [
    {
      id: "steps",
      label: "Steps",
      present: stepsChart.length > 0,
      latestDate: lastDateOf(stepsChart),
      order: 0,
      node: (
        <div id="steps" className={anchorClass} key="steps">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Steps per day
          </h2>
          <LineChartCard
            data={stepsChart}
            label="Steps"
            color={chartSeries.emerald}
          />
        </div>
      ),
    },
    {
      id: "sleep",
      label: "Sleep",
      present: hasSleep,
      latestDate: visibleLastNight?.wakeDay ?? null,
      order: 1,
      node: (
        <Link
          key="sleep"
          href="/sleep"
          id="sleep"
          className="card scroll-mt-28 group flex flex-col transition hover:border-brand-300 dark:hover:border-brand-700"
          data-testid="sleep-summary-tile"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Sleep
            </h2>
            <span className="inline-flex items-center gap-1 text-xs text-brand-600 group-hover:underline dark:text-brand-400">
              Open Sleep
              <IconArrowRight className="h-4 w-4" stroke={1.75} aria-hidden />
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            {visibleLastNight && lastNightPresentation && (
              <div>
                <div
                  className="text-3xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
                  data-testid="sleep-tile-duration"
                >
                  {formatHm(visibleLastNight.durationMin)}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {lastNightPresentation.label}
                  {visibleLastNight.bedMinutes != null &&
                    visibleLastNight.wakeMinutes != null && (
                      <>
                        {" · "}
                        {formatClockMinutes(
                          formatPrefs.timeFormat,
                          visibleLastNight.bedMinutes
                        )}
                        –
                        {formatClockMinutes(
                          formatPrefs.timeFormat,
                          visibleLastNight.wakeMinutes
                        )}
                      </>
                    )}
                </div>
              </div>
            )}
            {sleepReg != null && (
              <div data-testid="sleep-regularity">
                <div
                  className="text-3xl font-bold text-indigo-600 dark:text-indigo-300"
                  data-testid="sri-value"
                >
                  {sriPresentation(sleepReg.sri).text}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Regularity
                </div>
              </div>
            )}
          </div>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Your regularity trend, stage composition, and per-night detail moved
            to the Sleep page.
          </p>
        </Link>
      ),
    },
    {
      id: "hr",
      label: "HR",
      present: hrChart.length > 0,
      latestDate: lastDateOf(hrChart),
      order: 2,
      node: (
        <div id="hr" className={anchorClass} key="hr">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Heart rate (daily avg)
          </h2>
          <LineChartCard
            data={hrChart}
            label="Avg HR"
            color={chartSeries.rose}
            unit=" bpm"
          />
        </div>
      ),
    },
    {
      id: "hr-day",
      label: "HR (day)",
      present: hrIntraday.length > 0,
      latestDate: latestHrDay,
      order: 3,
      node: (
        <div
          id="hr-day"
          className={`${anchorClass} lg:col-span-2`}
          key="hr-day"
        >
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Heart rate over the day
            {latestHrDay ? ` — ${latestHrDay}` : ""}
          </h2>
          <LineChartCard
            data={hrIntraday}
            label="HR"
            color={chartSeries.rose}
            unit=" bpm"
            showDots={false}
          />
        </div>
      ),
    },
    {
      id: "bmi",
      label: "BMI",
      present: bmiChart.length > 0,
      latestDate: lastDateOf(bmiChart),
      order: 4,
      node: (
        <div id="bmi" className={anchorClass} key="bmi">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            BMI
          </h2>
          <LineChartCard
            data={bmiChart}
            label="BMI"
            color={chartSeries.emerald}
          />
        </div>
      ),
    },
    {
      id: "lean-mass",
      label: "Lean mass",
      present: leanMassChart.length > 0,
      latestDate: lastDateOf(leanMassChart),
      order: 5,
      node: (
        <div id="lean-mass" className={anchorClass} key="lean-mass">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Lean body mass
          </h2>
          <LineChartCard
            data={leanMassChart}
            label="Lean mass"
            color={chartSeries.emerald}
            unit=" kg"
          />
        </div>
      ),
    },
    {
      id: "bone-mass",
      label: "Bone mass",
      present: boneMassChart.length > 0,
      latestDate: lastDateOf(boneMassChart),
      order: 6,
      node: (
        <div id="bone-mass" className={anchorClass} key="bone-mass">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Bone mass
          </h2>
          <LineChartCard
            data={boneMassChart}
            label="Bone mass"
            color={chartSeries.slate}
            unit=" kg"
          />
        </div>
      ),
    },
    {
      id: "bmr",
      label: "BMR",
      present: bmrChart.length > 0,
      latestDate: lastDateOf(bmrChart),
      order: 7,
      node: (
        <div id="bmr" className={anchorClass} key="bmr">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Basal metabolic rate
          </h2>
          <LineChartCard
            data={bmrChart}
            label="BMR"
            color={chartSeries.rose}
            unit=" kcal"
          />
        </div>
      ),
    },
    {
      id: "hydration",
      label: "Hydration",
      present: hydrationChart.length > 0,
      latestDate: lastDateOf(hydrationChart),
      order: 8,
      node: (
        <div id="hydration" className={anchorClass} key="hydration">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Hydration
          </h2>
          <LineChartCard
            data={hydrationChart}
            label="Water"
            color={chartSeries.emerald}
            unit=" L"
          />
        </div>
      ),
    },
    {
      id: "calories",
      label: "Calories",
      present: caloriesChart.length > 0,
      latestDate: lastDateOf(caloriesChart),
      order: 9,
      node: (
        <div id="calories" className={anchorClass} key="calories">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Calories (intake)
          </h2>
          <LineChartCard
            data={caloriesChart}
            label="Calories"
            color={chartSeries.amber}
            unit=" kcal"
          />
        </div>
      ),
    },
    {
      id: "macros",
      label: "Macros",
      present: macrosChart.length > 0,
      // macrosChart's `date` is sliced to MM-DD for display; use the full-date
      // macroDates for recency so the sort stays correct across year boundaries.
      latestDate:
        macroDates.length > 0 ? macroDates[macroDates.length - 1] : null,
      order: 10,
      node: (
        <div
          id="macros"
          className={`${anchorClass} lg:col-span-2`}
          key="macros"
        >
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Macros (protein / carbs / fat)
          </h2>
          <StackedBarCard
            data={macrosChart}
            unit=" g"
            series={[
              {
                key: "protein",
                label: "Protein",
                color: chartSeries.violet,
              },
              { key: "carbs", label: "Carbs", color: chartSeries.amber },
              { key: "fat", label: "Fat", color: chartSeries.rose },
            ]}
          />
        </div>
      ),
    },
  ];
  const orderedSynced = orderBodyCharts(syncedEntries);

  // Two fixed leading sections outside the reorderable synced grid, each with ONE
  // presence boolean shared by its chip and its render (no duplicated has-data
  // check): the body-composition block (weight / body-fat / resting-HR) and Mood.
  const hasBodyComposition = charts.some((c) => c.data.length > 0);
  const hasMood = moodChart.length > 0;

  // Jump chips in page reading order: body-composition, mood, then the synced
  // charts in their relevance order. ONE list feeds the sticky chip row.
  const jumpChips: ChartChip[] = [
    ...(hasBodyComposition
      ? [{ id: "body-composition", label: "Weight" }]
      : []),
    ...(hasMood ? [{ id: "mood", label: "Mood" }] : []),
    ...orderedSynced.map((e) => ({ id: e.id, label: e.label })),
  ];

  // The three entry forms, collapsed to a chip row on mobile (#1067). Authored
  // once here; QuickAddPanel renders each a single time (no hand-mirrored branch).
  const quickAddItems: QuickAddItem[] = [
    {
      id: "body",
      label: "Body",
      node: (
        <BodyQuickAdd
          weightUnit={wu}
          defaultDate={today(profile.id)}
          showBodyFat={bodyFatShown}
        />
      ),
    },
    ...(showGrowthQuickAdd(ageYears)
      ? [
          {
            id: "growth" as const,
            label: "Growth",
            node: (
              <GrowthQuickAdd
                defaultDate={today(profile.id)}
                showHeadCirc={showHeadCircEntry(ageMonths)}
              />
            ),
          },
        ]
      : []),
    {
      id: "vitals",
      label: "Vitals",
      node: (
        <VitalsQuickAdd
          defaultDate={today(profile.id)}
          temperatureUnit={units.temperatureUnit}
        />
      ),
    },
  ];

  // #1067 Phase 2: the sparkline-tile overview. Each tile is the 30-day tail of the
  // SAME display-unit series its classic chart draws above (one gather feeds both).
  // Body fat is dropped for a growth-tracked profile (matching the charts/history);
  // every other metric self-gates on presence (buildBodyMetricTile → present=false
  // ⇒ orderBodyMetricTiles drops it). Sleep is a SPECIAL tile linking to /sleep.
  const tileSeries: Array<[BodyMetricSlug, { date: string; value: number }[]]> =
    [
      ["weight", weightAll],
      ["body-fat", bodyFatAll],
      ["resting-hr", restingHrAll],
      ["height", heightAll],
      ["head-circ", headCircAll],
      ["steps", stepsChart],
      ["hr", hrChart],
      ["bmi", bmiChart],
      ["lean-mass", leanMassChart],
      ["bone-mass", boneMassChart],
      ["bmr", bmrChart],
      ["hydration", hydrationChart],
      ["calories", caloriesChart],
      ["mood", moodChart],
    ];
  const metricTiles: BodyMetricTile[] = tileSeries
    .filter(([slug]) => slug !== "body-fat" || bodyFatShown)
    .map(([slug, arr]) =>
      buildBodyMetricTile(BODY_METRIC_META[slug], arr, wu, todayStr)
    )
    .filter((t) => t.present);

  // The bespoke Sleep tile for the grid — links to /sleep (strong topic keeps its
  // own surface, #1042), NOT a metric page. A distinct node from the stack's sleep
  // card so there's no duplicate `#sleep` anchor id across the two layouts.
  const sleepGridTile = hasSleep
    ? {
        present: true,
        latestDate: lastNight?.wakeDay ?? null,
        node: (
          <Link
            href="/sleep"
            data-testid="body-tile-sleep"
            className="card group flex h-full flex-col transition hover:border-brand-300 dark:hover:border-brand-700"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                Sleep
              </span>
              <IconArrowRight
                className="h-4 w-4 text-brand-600 dark:text-brand-400"
                stroke={1.75}
                aria-hidden
              />
            </div>
            {lastNight && (
              <div className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
                {formatHm(lastNight.durationMin)}
              </div>
            )}
            {sleepReg != null && (
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Regularity {Math.round(sleepReg.sri)}/100
              </div>
            )}
            {!lastNight && sleepReg == null && (
              <div className="text-sm text-slate-500 dark:text-slate-400">
                Open Sleep
              </div>
            )}
          </Link>
        ),
      }
    : null;

  return (
    <div className="space-y-6">
      <QuickAddPanel items={quickAddItems} />

      {/* Body-metric data-hygiene findings (issue #45, domain 5): probable-error
          day-over-day weight jumps — a safety-ish signal, so shown above the toggle
          in both layouts. */}
      <BodyHygieneFindings />

      {/* #1067 Phase 2: tiles ⇄ classic-stack toggle. Default is responsive (tiles on
          mobile, stack on desktop); the toggle pins either explicitly. */}
      <div className="flex justify-end">
        <BodyViewToggle view={view} tilesHref={tilesHref} allHref={allHref} />
      </div>

      {/* Sparkline-tile overview — the default view on mobile. */}
      <div className={tilesContainerClass(view)} data-testid="body-tiles-view">
        <BodyMetricTiles tiles={metricTiles} sleep={sleepGridTile} />
      </div>

      {/* The classic full-chart stack — the default view on desktop, and the
          `view=all` layout on every viewport. Carries the sticky jump chips + the
          per-chart `#id` anchors (#1067 Phase 1). */}
      <div
        className={`${stackContainerClass(view)} space-y-6`}
        data-testid="body-charts-all"
      >
        {/* Sticky chart-jump chips (#1067) — one row, its own overflow-x-auto
            container, tapping scrolls to the chart. Only present charts appear. */}
        <ChartJumpChips chips={jumpChips} />

        <p className="text-sm text-slate-500 dark:text-slate-400">
          Body-composition trends over the selected window.
        </p>

        {/* For a child the growth-percentile card is the headline, so it floats
            above the body-composition charts (plan.growthCardFirst); adults keep
            it below, unchanged. */}
        {plan.growthCardFirst && growthCard}

        <div id="body-composition" className="scroll-mt-28">
          <BodyTrendCharts
            charts={charts}
            annotations={annotations}
            windows={protocolWindows}
          />
        </div>

        {!plan.growthCardFirst && growthCard}

        {/* Mood trend (#992): the daily wellbeing series. Deliberately no reference
          bands, no flags, no retest hooks — mood is not a lab, so a low day is a
          data point, never an "abnormal". Hidden until a check-in exists. */}
        {hasMood && (
          <div id="mood" className="card scroll-mt-28" data-testid="mood-trend">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                Mood
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                1–5 daily check-ins · most recent ~6 months
              </span>
            </div>
            <LineChartCard
              data={moodChart}
              label="Mood"
              color={chartSeries.amber}
            />
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              A subjective self-rating from your daily check-ins — informational
              only, never range-checked.
            </p>
          </div>
        )}

        {hasSynced && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Synced daily metrics — most recent ~6 months (not filtered by the
              date range above).
            </p>
            <div className="grid gap-6 lg:grid-cols-2">
              {orderedSynced.map((e) => e.node)}
            </div>
          </div>
        )}

        {/* Per-source comparison + primary-source pickers (issue #14). Renders
          nothing unless at least one metric is reported by 2+ sources. */}
        <SourceComparison profileId={profile.id} weightUnit={wu} />

        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            History
          </h2>
          {bodyMetrics.length === 0 ? (
            <EmptyState message="No body metrics yet. Log one above to see the trend." />
          ) : (
            <ScrollFade>
              <table className="w-full" data-testid="body-history-table">
                <thead>
                  <tr className="border-b border-black/5 dark:border-white/10">
                    <th className="th">Date</th>
                    <th className="th">Weight</th>
                    {bodyFatShown && <th className="th">Body fat</th>}
                    <th className="th">Resting HR</th>
                    <th className="th">Source</th>
                    <th className="th">Notes</th>
                    <th className="th"></th>
                  </tr>
                </thead>
                <tbody>
                  {bodyMetrics.map((w) => (
                    <tr
                      key={w.id}
                      className="border-b border-black/5 dark:border-white/10"
                    >
                      <td className="td whitespace-nowrap">
                        {formatLongDate(w.date, formatPrefs)}
                      </td>
                      <td
                        className="td font-medium"
                        data-testid="body-weight-cell"
                      >
                        {fmtWeight(w.weight_kg, wu)}
                      </td>
                      {bodyFatShown && (
                        <td className="td">
                          {w.body_fat_pct != null ? `${w.body_fat_pct}%` : "—"}
                        </td>
                      )}
                      <td className="td">{w.resting_hr ?? "—"}</td>
                      <td className="td whitespace-nowrap">
                        {w.document_id != null ? (
                          <Link
                            href={`/import/${w.document_id}`}
                            className="text-brand-700 hover:underline dark:text-brand-400"
                          >
                            {w.source_label}
                          </Link>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400">
                            {w.source_label}
                          </span>
                        )}
                        {/* Edit-lock badge + resume affordance for a hand-edited
                          integration row (#659): only integration-owned rows carry
                          the lock (manual/document rows can't be re-synced). */}
                        {!!w.edited &&
                          w.document_id == null &&
                          !!w.source &&
                          w.source !== "manual" && (
                            <EditLockNotice
                              table="body_metrics"
                              id={w.id}
                              className="mt-1"
                            />
                          )}
                      </td>
                      <td className="td text-slate-500 dark:text-slate-400">
                        <NotesText notes={w.notes} />
                      </td>
                      <td className="td text-right">
                        <DeleteBodyMetricButton
                          id={w.id}
                          label={formatLongDate(w.date, formatPrefs)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollFade>
          )}
        </div>
      </div>
    </div>
  );
}
