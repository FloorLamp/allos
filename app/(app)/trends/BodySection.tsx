import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { chartSeries } from "@/lib/chart-colors";
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
  getSleepStageDailyTotals,
  getSleepRegularity,
  getSleepRegularityTrend,
  getSleepRegularityInsight,
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
import {
  buildTrendAnnotations,
  buildProtocolTrendWindows,
} from "@/lib/trends-series";
import { projectGoal, describeEta } from "@/lib/trend-projection";
import { formatLongDate } from "@/lib/format-date";
import { isGoalLive } from "@/lib/goals";
import type { BodyMetricKind, Goal } from "@/lib/types";
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
export default async function BodySection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const wu = units.weightUnit;

  // Read the whole series (ALL_ROWS overrides the default 365-row cap) so an
  // older window isn't silently truncated before filterSeriesByRange windows it.
  // The chart series read one value per day through getBodyMetricDailySeries
  // (issue #14): when several sources report the same day, the profile's primary
  // source (else the default preference) wins, so a two-device day doesn't
  // zig-zag the trend. The history table below keeps every row (all sources).
  const weightSeries = getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS);
  const bodyMetrics = getBodyMetricsWithSource(profile.id, ALL_ROWS);

  const weightChart = filterSeriesByRange(
    weightSeries.map((w) => ({ date: w.date, value: dispWeight(w.value, wu) })),
    range
  );
  const bodyFatChart = filterSeriesByRange(
    getBodyMetricDailySeries(profile.id, "body_fat", ALL_ROWS).map((w) => ({
      date: w.date,
      value: round(w.value, 1),
    })),
    range
  );
  const restingHrChart = filterSeriesByRange(
    getBodyMetricDailySeries(profile.id, "resting_hr", ALL_ROWS).map((w) => ({
      date: w.date,
      value: Math.round(w.value),
    })),
    range
  );

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
  const heightChart = filterSeriesByRange(
    getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map((r) => ({
      date: r.date,
      value: round(r.value, 1),
    })),
    range
  );
  const headCircChart = filterSeriesByRange(
    getMetricDailyTotals(profile.id, "head_circumference_cm", ALL_ROWS).map(
      (r) => ({
        date: r.date,
        value: round(r.value, 1),
      })
    ),
    range
  );

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
  const sleepChart = getMetricDailyTotals(profile.id, "sleep_min").map((r) => ({
    date: r.date,
    value: round(r.value / 60, 1), // minutes → hours
  }));
  // Sleep Regularity Index (#160): consistency of sleep/wake timing over a rolling
  // 28-night window — a mortality-linked signal the nightly-duration chart can't
  // show. Null (card hidden) until the minimum-nights gate is met.
  const sleepReg = getSleepRegularity(profile.id);
  const sleepRegTrend = getSleepRegularityTrend(profile.id).map((r) => ({
    date: r.date,
    value: r.sri,
  }));
  const sleepRegInsight = getSleepRegularityInsight(profile.id);
  const sleepStages = getSleepStageDailyTotals(profile.id).map((r) => ({
    date: r.date.slice(5),
    deep: round(r.deep / 60, 1),
    rem: round(r.rem / 60, 1),
    light: round(r.light / 60, 1),
    awake: round(r.awake / 60, 1),
  }));
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
    sleepChart.length > 0 ||
    sleepReg != null ||
    sleepStages.length > 0 ||
    hrChart.length > 0 ||
    leanMassChart.length > 0 ||
    boneMassChart.length > 0 ||
    bmrChart.length > 0 ||
    hydrationChart.length > 0 ||
    caloriesChart.length > 0 ||
    macrosChart.length > 0 ||
    bmiChart.length > 0;

  return (
    <div className="space-y-6">
      <BodyQuickAdd
        weightUnit={wu}
        defaultDate={today(profile.id)}
        showBodyFat={bodyFatShown}
      />

      {showGrowthQuickAdd(ageYears) && (
        <GrowthQuickAdd
          defaultDate={today(profile.id)}
          showHeadCirc={showHeadCircEntry(ageMonths)}
        />
      )}

      <VitalsQuickAdd
        defaultDate={today(profile.id)}
        temperatureUnit={units.temperatureUnit}
      />

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Body-composition trends over the selected window.
      </p>

      {/* Body-metric data-hygiene findings (issue #45, domain 5): probable-error
          day-over-day weight jumps, before they skew the charts below. */}
      <BodyHygieneFindings />

      {/* For a child the growth-percentile card is the headline, so it floats
          above the body-composition charts (plan.growthCardFirst); adults keep
          it below, unchanged. */}
      {plan.growthCardFirst && growthCard}

      <BodyTrendCharts
        charts={charts}
        annotations={annotations}
        windows={protocolWindows}
      />

      {!plan.growthCardFirst && growthCard}

      {/* Mood trend (#992): the daily wellbeing series. Deliberately no reference
          bands, no flags, no retest hooks — mood is not a lab, so a low day is a
          data point, never an "abnormal". Hidden until a check-in exists. */}
      {moodChart.length > 0 && (
        <div className="card" data-testid="mood-trend">
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
            {stepsChart.length > 0 && (
              <div className="card">
                <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                  Steps per day
                </h2>
                <LineChartCard
                  data={stepsChart}
                  label="Steps"
                  color={chartSeries.emerald}
                />
              </div>
            )}
            {sleepChart.length > 0 && (
              <div className="card">
                <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                  Sleep per night
                </h2>
                <LineChartCard
                  data={sleepChart}
                  label="Sleep"
                  color={chartSeries.violet}
                  unit=" h"
                />
              </div>
            )}
            {sleepReg != null && (
              <div className="card" data-testid="sleep-regularity">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                    Sleep regularity
                  </h2>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    SRI · last {sleepReg.nights} nights
                  </span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span
                    className="text-3xl font-bold text-indigo-600 dark:text-indigo-300"
                    data-testid="sri-value"
                  >
                    {Math.round(sleepReg.sri)}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    / 100
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Consistency of your sleep/wake timing (higher is steadier).
                  Bedtime ±{sleepReg.bedtimeSdMin} min, wake ±
                  {sleepReg.waketimeSdMin} min
                  {sleepReg.socialJetlagMin != null
                    ? `, ${(sleepReg.socialJetlagMin / 60).toFixed(1)} h weekend shift`
                    : ""}
                  .
                </p>
                {sleepRegInsight && (
                  <p
                    className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                    data-testid="sri-insight"
                  >
                    {sleepRegInsight}
                  </p>
                )}
                {sleepRegTrend.length > 1 && (
                  <div className="mt-3">
                    <LineChartCard
                      data={sleepRegTrend}
                      label="SRI"
                      color={chartSeries.violet}
                    />
                  </div>
                )}
              </div>
            )}
            {sleepStages.length > 0 && (
              <div className="card lg:col-span-2">
                <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                  Sleep stages
                </h2>
                <StackedBarCard
                  data={sleepStages}
                  unit=" h"
                  series={[
                    { key: "deep", label: "Deep", color: chartSeries.violet },
                    { key: "rem", label: "REM", color: chartSeries.rose },
                    {
                      key: "light",
                      label: "Light",
                      color: chartSeries.emerald,
                    },
                    { key: "awake", label: "Awake", color: chartSeries.amber },
                  ]}
                />
              </div>
            )}
            {hrChart.length > 0 && (
              <div className="card">
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
            )}
            {hrIntraday.length > 0 && (
              <div className="card lg:col-span-2">
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
            )}
            {bmiChart.length > 0 && (
              <div className="card">
                <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                  BMI
                </h2>
                <LineChartCard
                  data={bmiChart}
                  label="BMI"
                  color={chartSeries.emerald}
                />
              </div>
            )}
            {leanMassChart.length > 0 && (
              <div className="card">
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
            )}
            {boneMassChart.length > 0 && (
              <div className="card">
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
            )}
            {bmrChart.length > 0 && (
              <div className="card">
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
            )}
            {hydrationChart.length > 0 && (
              <div className="card">
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
            )}
            {caloriesChart.length > 0 && (
              <div className="card">
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
            )}
            {macrosChart.length > 0 && (
              <div className="card lg:col-span-2">
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
            )}
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
  );
}
