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
  getHomeLocation,
  getTimezone,
} from "@/lib/settings";
import {
  ageInMonthsFromBirthdate,
  daysBetweenDateStr,
  lastNDates,
  shiftDateStr,
} from "@/lib/date";
import {
  planBodyCharts,
  showGrowthQuickAdd,
  showHeadCircEntry,
  showBodyFat,
  type BodyChartKey,
} from "@/lib/growth-metrics";
import {
  getBiomarkerSeries,
  getBodyMetricDailySeries,
  getBodyMetricsWithSource,
  getDaylightOutdoorMinutesSeries,
  getMetricDailyTotals,
  getSleepRegularity,
  getLastNightSummary,
  getHrDailySummary,
  getLatestHrDay,
  getHrMinutes,
  getGoals,
  getMoodLogs,
  buildTrendsSubjectContext,
} from "@/lib/queries";
import { dispWeight, fmtWeight, round } from "@/lib/units";
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "@/lib/vitals-input";
import {
  buildGrowthProfile,
  bmiSeriesDatePaired,
  displayWeightGrowth,
} from "@/lib/growth-series";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import {
  applyCardOrder,
  bodyCardOrder,
  growthCardLeads,
} from "@/lib/trends-card-rank";
import { getTrendsCardOrder } from "@/lib/settings";
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
import {
  buildTodayVitalsStrip,
  hrSlotSeries,
  intradayVitalPoints,
  toIntradaySlotSeries,
  type VitalReadingRow,
} from "@/lib/vitals-day";
import { projectGoal, describeEta } from "@/lib/trend-projection";
import { formatLongDate, formatClockMinutes } from "@/lib/format-date";
import { isGoalLive } from "@/lib/goals";
import { isIntradayRange, type DateRange } from "@/lib/timeline-format";
import { metricDetailHref, timelineDayHref, type AppRoute } from "@/lib/hrefs";
import type { BodyMetricKind, Goal, MedicalRecord } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import ChartCard, { CHART_PLOT_FILL } from "@/components/ChartCard";
import NotesText from "@/components/NotesText";
import ScrollFade from "@/components/ScrollFade";
import BodyTrendCharts, {
  type BodyChartSpec,
  type BodyChartSection,
} from "@/components/BodyTrendCharts";
import GrowthChartsCard, {
  type GrowthMetricView,
} from "@/components/GrowthChartsCard";
import LogMeasurementsPanel from "./LogMeasurementsPanel";
import VitalsTodayStrip from "./VitalsTodayStrip";
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

// The Trends hub's **Body** tab — the ONE physiology surface (issue #1486).
//
// Trends carried a Vitals tab and a Body tab that answered the same question about
// the same person from the same rows: "what is my body doing". A blood pressure was
// on one, a weight on the other, and resting heart rate was on BOTH (charted twice,
// with a goal overlay on only one of them). #1486 retires the Vitals tab into this
// one, in the order a reader actually wants:
//
//   1. **Today** — the latest reading per vital with its clock time (the #1466
//      strip), plus the 1D pill's intraday swap and the desktop "+ Log" expander.
//   2. **Vitals** — blood pressure, oxygen saturation, respiratory rate, resting
//      heart rate (its ONE home now: Body's copy retired and its goal overlay +
//      event annotations moved HERE, so the two copies' affordances are unioned
//      rather than one of them being dropped), HRV, sun/outdoor time, and body
//      temperature in its ACUTE recent-readings view with the fever line.
//   3. **Composition** — weight and body fat with their goal overlays (height and
//      head circumference instead, for a growth-tracked profile).
//   4. The growth-percentile card (minors), the mood + synced-metric charts, the
//      per-source comparison, and the full history table (whose resting-HR COLUMN
//      stays — that table is the record editor, not a chart).
//
// The #1067 `view` param keeps its exact meaning, and the vitals JOINED it: in
// `tiles` they are sparkline tiles like every other metric, in `all` they are full
// charts. One view-mode semantic, not two.
//
// `?tab=vitals` still lands here — a vocabulary mapping in lib/trends-tabs.ts, not a
// redirect layer, so every old deep link keeps working.

type Point = { date: string; value: number };

// medical_records vitals (BP / SpO2 / respiratory rate / temperature) — one value
// per reading, mapped to the {date,value} the chart takes.
function vitalPoints(rows: MedicalRecord[], decimals = 0): Point[] {
  return rows
    .filter((r) => r.value_num != null)
    .map((r) => ({
      date: r.date,
      value: round(r.value_num as number, decimals),
    }));
}

// A daily aggregate ({date,value}) in the row shape the Today strip reads. These
// series carry no clock time by construction (they ARE the day's number), which is
// why they show a value without a time rather than being charted at 1D.
function dailyRows(series: Point[]): VitalReadingRow[] {
  return series.map((d) => ({ date: d.date, value_num: d.value }));
}

// Fahrenheit fever threshold (100.4 °F / 38 °C) — the reference line on the acute
// temperature view, matching the illness/fever surface (#859).
const FEVER_F = 100.4;
// The acute temperature view shows only the most recent readings (never a years
// trajectory), regardless of the shared window.
const TEMP_RECENT = 30;
// The intraday charts are the tab's densest content and the only place a phone gets
// a full-viewport plot, so they run taller than the standard windowed cards from `sm`
// up. Below `sm` every chart card is the #1488 square, so these carry only the
// DESKTOP height — written as whole literal class strings (never `sm:${x}`), which is
// the only form Tailwind's source scanner can see.
const INTRADAY_PLOT_HEIGHT = "sm:h-80";
const INTRADAY_POINT_PLOT_HEIGHT = "sm:h-56";
// Full-bleed on a phone: cancel the shell's 1rem gutter, drop the card's horizontal
// padding, rounding and side borders, and neutralize `.card`'s own `max-w-full` —
// which would otherwise clamp the widened box back to the container width and merely
// SHIFT the card instead of widening it. From `sm` up it is an ordinary card again.
const FULL_BLEED_CARD =
  "card -mx-4 max-w-none rounded-none border-x-0 px-0 sm:mx-0 sm:max-w-full sm:rounded-xl sm:border-x sm:px-5";

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
  const tz = getTimezone(profile.id);
  const wu = units.weightUnit;
  // The 1D pill's window (from == to == today). Only this tab offers that pill,
  // because only this tab has intraday content to swap in.
  const intraday = isIntradayRange(range, todayStr);

  // ── Reads ───────────────────────────────────────────────────────────────────
  // Read the whole series (ALL_ROWS overrides the default 365-row cap) so an older
  // window isn't silently truncated before filterSeriesByRange windows it. The chart
  // series read one value per day through getBodyMetricDailySeries (issue #14): when
  // several sources report the same day, the profile's primary source (else the
  // default preference) wins, so a two-device day doesn't zig-zag the trend. The
  // history table below keeps every row (all sources).
  const weightSeries = getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS);
  const bodyMetrics = getBodyMetricsWithSource(profile.id, ALL_ROWS);

  // Keep the UNWINDOWED display-unit series named (…All) so the overview tiles read
  // their 30-day tail from the SAME arrays the windowed charts draw — one gather
  // feeds both (#221). The chart applies the shared range on top.
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

  // The vitals' RAW, unwindowed reading rows (absorbed from the retired Vitals
  // section). The charts window them below; the Today strip and the intraday charts
  // read today out of these same arrays, so a past custom window never hides today's
  // answer — and no extra query is issued either way.
  const systolicRows = getBiomarkerSeries(
    profile.id,
    "Blood Pressure Systolic"
  );
  const diastolicRows = getBiomarkerSeries(
    profile.id,
    "Blood Pressure Diastolic"
  );
  const spo2Rows = getBiomarkerSeries(profile.id, "Oxygen Saturation");
  const respiratoryRows = getBiomarkerSeries(profile.id, "Respiratory Rate");
  const temperatureRows = getBiomarkerSeries(profile.id, "Body Temperature");
  const hrvAll = getMetricDailyTotals(profile.id, HRV_METRIC, 3650).map(
    (d) => ({
      date: d.date,
      value: Math.round(d.value),
    })
  );
  // Skin temperature variation keeps 1 decimal, unlike its whole-unit neighbours:
  // it is a signed deviation whose whole readable range is roughly ±2 °C, so
  // rounding to whole units would flatten the series to a constant 0.
  // getMetricDailyTotals AVERAGES this metric per day (AVERAGED_METRICS), never sums.
  const skinTempAll = getMetricDailyTotals(
    profile.id,
    SKIN_TEMP_DELTA_METRIC,
    3650
  ).map((d) => ({
    date: d.date,
    value: Math.round(d.value * 10) / 10,
  }));

  const systolicAll = vitalPoints(systolicRows);
  const diastolicAll = vitalPoints(diastolicRows);
  const spo2All = vitalPoints(spo2Rows);
  const respiratoryAll = vitalPoints(respiratoryRows);
  const temperatureAll = vitalPoints(temperatureRows, 1);

  const systolicChart = filterSeriesByRange(systolicAll, range);
  const diastolicChart = filterSeriesByRange(diastolicAll, range);
  const spo2Chart = filterSeriesByRange(spo2All, range);
  const respiratoryChart = filterSeriesByRange(respiratoryAll, range);
  const hrvChart = filterSeriesByRange(hrvAll, range);
  const skinTempChart = filterSeriesByRange(skinTempAll, range);

  // Temperature: acute — the most recent readings only, newest kept, oldest first.
  const temperatureRecent = temperatureAll
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-TEMP_RECENT);

  // Age drives chart MEMBERSHIP: for a growth-tracked profile the tab charts height
  // (and head circ for the very young) and drops body fat entirely. That decision
  // stays the pure lib/growth-metrics (planBodyCharts), shared with tests.
  //
  // The ORDER those charts render in is no longer decided here (#1490). Every card
  // on this tab is sequenced by ONE ranker (lib/trends-card-rank.ts) over STABLE
  // subject facts — life stage, live goals, monitored conditions, data presence —
  // so the old hand-rolled forks (planBodyCharts' `growthCardFirst` and the
  // trends-body-order recency sort) are one signal table now instead of two
  // per-surface rules. A profile that has ARRANGED this tab keeps its own order
  // forever; the ranked default only serves a never-arranged profile.
  const ageYears = getUserAge(profile.id);
  const birthdate = getUserBirthdate(profile.id);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, todayStr)
    : null;
  const plan = planBodyCharts({ ageYears, ageMonths });
  const cardOrder = bodyCardOrder(
    buildTrendsSubjectContext(profile.id, todayStr),
    getTrendsCardOrder(profile.id, "body")
  );
  // Body fat % is de-prioritized for a growth-tracked profile. #493: apply the ONE
  // showBodyFat predicate at EVERY interactive surface — the charts (via plan.keys),
  // the entry field, and the history column — so "not tracked" is consistent instead
  // of hidden-from-charts-but-still-enterable. (The raw data export keeps the column,
  // a complete-record contract distinct from this display choice.)
  const bodyFatShown = showBodyFat(ageYears);

  // Height + head-circumference series (canonical cm, from metric_samples — the same
  // store the growth charts read). Read the WHOLE series (ALL_ROWS) before windowing
  // (issue #399): the default 180-row cap hides an older window entirely.
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
  // windowed to the shared range — ONE set drives every chart in BOTH sections via
  // the single toggle bar. Reads only through profile-scoped queries.
  const annotations = buildTrendAnnotations(profile.id, range);
  // Protocol intervention windows (issue #660), shaded across the charts via the
  // same toggle bar as the point annotations.
  const protocolWindows = buildProtocolTrendWindows(profile.id, range);

  // Goal projection: for a body-metric goal with a target value + target_date, draw
  // the target line and extrapolate the windowed trend to it. Weight targets are
  // stored canonically (kg) → convert to the display unit so the line and the
  // projection math share the chart's unit. First active, non-archived goal per
  // metric wins (getGoals returns active-first).
  const goals = getGoals(profile.id);
  const goalFor = (metric: BodyMetricKind): Goal | undefined =>
    goals.find(
      (g) => g.body_metric === metric && isGoalLive(g) && g.target_value != null
    );

  const goalOverlay = (
    metric: BodyMetricKind,
    data: Point[],
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

  // ── 1. Today ────────────────────────────────────────────────────────────────
  // A formatter over the arrays above (buildTodayVitalsStrip picks the latest
  // reading of each vital on today and resolves its clock time).
  const todayVitals = buildTodayVitalsStrip(
    [
      {
        key: "bp",
        label: "Blood pressure",
        unit: "mmHg",
        rows: systolicRows,
        pairRows: diastolicRows,
      },
      {
        key: "resting-hr",
        label: "Resting HR",
        unit: "bpm",
        rows: dailyRows(restingHrAll),
      },
      { key: "spo2", label: "Oxygen sat.", unit: "%", rows: spo2Rows },
      {
        key: "respiratory-rate",
        label: "Respiratory rate",
        unit: "/min",
        rows: respiratoryRows,
      },
      {
        key: "temperature",
        label: "Temperature",
        unit: "°F",
        rows: temperatureRows,
        decimals: 1,
      },
      { key: "hrv", label: "HRV", unit: "ms", rows: dailyRows(hrvAll) },
    ],
    todayStr,
    tz
  );

  // The 1D swap. Built ONLY at 1D, so an ordinary window never pays for the day's
  // minute scan. HR comes from the SAME getHrMinutes read + downsampleHr model the
  // #1068 intraday panel draws — one computation, two formatters.
  const intradayHr = intraday
    ? hrSlotSeries(todayStr, getHrMinutes(profile.id, todayStr))
    : [];
  const intradaySystolic = intraday
    ? intradayVitalPoints(systolicRows, todayStr, tz)
    : [];
  const intradayDiastolic = intraday
    ? intradayVitalPoints(diastolicRows, todayStr, tz)
    : [];
  const intradaySpo2 = intraday
    ? intradayVitalPoints(spo2Rows, todayStr, tz)
    : [];
  const hasIntradayBp =
    intradaySystolic.length > 0 || intradayDiastolic.length > 0;
  const hasIntraday =
    intradayHr.length > 0 || hasIntradayBp || intradaySpo2.length > 0;

  // Sun / outdoor time (#1171): a trend over the SAME getDaylightOutdoorMinutes
  // computation the DaylightChip and the coaching average read (#221 — the chart is
  // a formatter, no second engine). Data-gated on a home location. Skipped at 1D: a
  // single day is not a trend.
  const home = intraday ? null : getHomeLocation(profile.id);
  let sun: Point[] = [];
  if (home) {
    const to = range.to ?? todayStr;
    const MAX_SERIES_DAYS = 366;
    const span = range.from
      ? Math.min((daysBetweenDateStr(range.from, to) ?? 0) + 1, MAX_SERIES_DAYS)
      : 90;
    const dates = lastNDates(to, Math.max(span, 1));
    sun = getDaylightOutdoorMinutesSeries(profile.id, dates);
  }

  // ── 2. Vitals section ───────────────────────────────────────────────────────
  // Every card is present-gated on its own series, so a profile with only a weight
  // never sees an empty vitals frame.
  const vitalsCharts: BodyChartSpec[] = [];
  if (systolicChart.length > 0) {
    vitalsCharts.push({
      key: "systolic",
      testid: "vitals-systolic",
      detailHref: metricDetailHref("systolic"),
      title: "Blood pressure (systolic)",
      data: systolicChart,
      label: "Systolic",
      unit: " mmHg",
      color: chartSeries.rose,
    });
  }
  if (diastolicChart.length > 0) {
    vitalsCharts.push({
      key: "diastolic",
      testid: "vitals-diastolic",
      detailHref: metricDetailHref("diastolic"),
      title: "Blood pressure (diastolic)",
      data: diastolicChart,
      label: "Diastolic",
      unit: " mmHg",
      color: chartSeries.violet,
    });
  }
  if (spo2Chart.length > 0) {
    vitalsCharts.push({
      key: "spo2",
      testid: "vitals-spo2",
      detailHref: metricDetailHref("spo2"),
      title: "Oxygen saturation",
      data: spo2Chart,
      label: "SpO₂",
      unit: "%",
      color: chartSeries.sky,
    });
  }
  if (respiratoryChart.length > 0) {
    vitalsCharts.push({
      key: "respiratory-rate",
      testid: "vitals-respiratory-rate",
      detailHref: metricDetailHref("respiratory-rate"),
      title: "Respiratory rate",
      data: respiratoryChart,
      label: "Respiratory rate",
      unit: " /min",
      color: chartSeries.violet,
    });
  }
  if (restingHrChart.length > 0) {
    // Resting HR appears EXACTLY ONCE (#1486): the Body tab's old copy retired and
    // its goal overlay + the shared event annotations came here with it.
    vitalsCharts.push({
      key: "resting_hr",
      testid: "vitals-resting-hr",
      detailHref: metricDetailHref("resting-hr"),
      title: "Resting heart rate",
      data: restingHrChart,
      label: "Resting HR",
      unit: " bpm",
      color: chartSeries.amber,
      ...goalOverlay("resting_hr", restingHrChart, " bpm", 0),
    });
  }
  if (hrvChart.length > 0) {
    vitalsCharts.push({
      key: "hrv",
      testid: "vitals-hrv",
      detailHref: metricDetailHref("hrv"),
      title: "Heart rate variability",
      data: hrvChart,
      label: "HRV",
      unit: " ms",
      color: chartSeries.amber,
    });
  }
  if (skinTempChart.length > 0) {
    vitalsCharts.push({
      key: "skin_temp",
      testid: "vitals-skin-temp",
      detailHref: metricDetailHref("skin-temp"),
      title: BODY_METRIC_META["skin-temp"].title,
      data: skinTempChart,
      label: BODY_METRIC_META["skin-temp"].label,
      unit: BODY_METRIC_META["skin-temp"].unit,
      color: BODY_METRIC_META["skin-temp"].color,
      note: "Nightly deviation from your tracker's own baseline, not an absolute temperature — so only the change matters, and it is comparable to your other nights rather than to a reference range. A sustained rise often shows up alongside a drop in HRV.",
    });
  }
  if (sun.length > 0) {
    vitalsCharts.push({
      key: "sun",
      testid: "vitals-sun-outdoor",
      detailHref: metricDetailHref("sun"),
      title: "Sun / outdoor time",
      data: sun,
      label: "Outdoor daylight",
      unit: " min",
      color: chartSeries.amber,
      note: "Daylight minutes from your outdoor sessions, scoped to the solar day at your home location. The same figure the day view's sun chip shows.",
    });
  }
  if (temperatureRecent.length > 0) {
    // Body TEMPERATURE keeps its ACUTE grammar — a recent-readings view with a fever
    // reference line and a link to the illness/fever surface — NEVER a years
    // trajectory (a fever is a spike, not a slow trend).
    vitalsCharts.push({
      key: "temperature",
      testid: "vitals-temperature",
      detailHref: metricDetailHref("temperature"),
      title: "Body temperature",
      data: temperatureRecent,
      label: "Temperature",
      unit: " °F",
      color: chartSeries.rose,
      referenceValue: { value: FEVER_F, label: "Fever" },
      note: `Recent readings (${temperatureRecent.length}). Temperature is an acute signal — a fever is tracked on the illness/fever chart, not a long-term trajectory.`,
      headerAction: (
        <Link
          href="/medical/episodes"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Illness episodes <IconArrowRight size={14} />
        </Link>
      ),
    });
  }

  // Sequence the vitals run by the tab's ONE card order (#1490). Membership is
  // still each card's own has-data gate above — the ranker only orders what the
  // section decided to render, so a monitored condition (hypertension → BP) or a
  // richly-tracked series leads the run without any card appearing or vanishing.
  const orderedVitals = applyCardOrder(vitalsCharts, cardOrder, (c) => c.key);

  const intradayBlock = intraday ? (
    !hasIntraday ? (
      <EmptyState message="Nothing intraday recorded today yet. Timed readings and worn heart-rate data show up here; pick a longer window for the daily trends." />
    ) : (
      <div className="space-y-6">
        {/* The intraday cards tap through to the DAILY detail page for the same
            metric (#1488): today's clock view is the zoom, the metric page is the
            full depth (its own range control, annotations, and readings table). */}
        {intradayHr.length > 0 && (
          <ChartCard
            title="Heart rate today"
            headingLevel="h3"
            detailHref={metricDetailHref("hr")}
            detailTitle="heart rate"
            surfaceClass={FULL_BLEED_CARD}
            headerClassName="px-4 sm:px-0"
            testid="vitals-intraday-hr"
            description="Per-minute heart rate across the clock, from the same day series the timeline's day view draws. A break in the line is a gap in wear, not a flat heart rate."
            plotHeightClass={INTRADAY_PLOT_HEIGHT}
          >
            {/* The plot spans the viewport on a phone — charts are the one content
                class that earns full-bleed; forms and text stay at the shell's
                normal width. */}
            <div
              data-testid="vitals-intraday-hr-plot"
              className="h-full w-full"
            >
              <LineChartCard
                data={intradayHr}
                label="Heart rate"
                unit=" bpm"
                color={chartSeries.rose}
                showDots={false}
                connectNulls={false}
                heightClass={CHART_PLOT_FILL}
              />
            </div>
          </ChartCard>
        )}

        {hasIntradayBp && (
          <div className="grid gap-6 sm:grid-cols-2">
            <ChartCard
              title="Systolic today"
              headingLevel="h3"
              detailHref={metricDetailHref("systolic")}
              detailTitle="systolic blood pressure"
              testid="vitals-intraday-bp"
              plotHeightClass={INTRADAY_POINT_PLOT_HEIGHT}
            >
              <LineChartCard
                data={toIntradaySlotSeries(intradaySystolic)}
                label="Systolic"
                unit=" mmHg"
                color={chartSeries.rose}
                connectNulls={false}
              />
            </ChartCard>
            <ChartCard
              title="Diastolic today"
              headingLevel="h3"
              detailHref={metricDetailHref("diastolic")}
              detailTitle="diastolic blood pressure"
              testid="vitals-intraday-bp-diastolic"
              plotHeightClass={INTRADAY_POINT_PLOT_HEIGHT}
            >
              <LineChartCard
                data={toIntradaySlotSeries(intradayDiastolic)}
                label="Diastolic"
                unit=" mmHg"
                color={chartSeries.violet}
                connectNulls={false}
              />
            </ChartCard>
          </div>
        )}

        {intradaySpo2.length > 0 && (
          <ChartCard
            title="Oxygen saturation today"
            headingLevel="h3"
            detailHref={metricDetailHref("spo2")}
            detailTitle="oxygen saturation"
            testid="vitals-intraday-spo2"
            plotHeightClass={INTRADAY_POINT_PLOT_HEIGHT}
          >
            <LineChartCard
              data={toIntradaySlotSeries(intradaySpo2)}
              label="SpO₂"
              unit="%"
              color={chartSeries.sky}
              connectNulls={false}
            />
          </ChartCard>
        )}

        <p className="text-xs text-slate-500 dark:text-slate-400">
          A reading logged without a clock time stays in the Today strip above —
          it can&rsquo;t be placed on a clock axis honestly.{" "}
          <Link
            href={timelineDayHref(todayStr)}
            className="font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            See today&rsquo;s timeline
          </Link>
          .
        </p>
      </div>
    )
  ) : null;

  // ── 3. Composition section ──────────────────────────────────────────────────
  // The age-aware plan minus resting HR, which the vitals section above now owns.
  const chartByKey: Record<BodyChartKey, BodyChartSpec> = {
    height: {
      key: "height",
      testid: "body-chart-height",
      detailHref: metricDetailHref("height"),
      title: "Height",
      data: heightChart,
      label: "Height",
      unit: " cm",
      color: chartSeries.violet,
    },
    head_circumference: {
      key: "head_circumference",
      testid: "body-chart-head-circ",
      detailHref: metricDetailHref("head-circ"),
      title: "Head circumference",
      data: headCircChart,
      label: "Head circ.",
      unit: " cm",
      color: chartSeries.sky,
    },
    weight: {
      key: "weight",
      testid: "body-chart-weight",
      detailHref: metricDetailHref("weight"),
      title: "Weight",
      data: weightChart,
      label: "Weight",
      unit: ` ${wu}`,
      color: chartSeries.brand,
      ...goalOverlay("weight", weightChart, ` ${wu}`, 1),
    },
    bodyfat: {
      key: "bodyfat",
      testid: "body-chart-bodyfat",
      detailHref: metricDetailHref("body-fat"),
      title: "Body fat",
      data: bodyFatChart,
      label: "Body fat",
      unit: "%",
      color: chartSeries.violet,
      ...goalOverlay("body_fat", bodyFatChart, "%", 1),
    },
    // Kept in the map (planBodyCharts still names it) but filtered OUT below — the
    // vitals section is resting HR's one home now.
    resting_hr: {
      key: "resting_hr",
      detailHref: metricDetailHref("resting-hr"),
      title: "Resting heart rate",
      data: restingHrChart,
      label: "Resting HR",
      unit: " bpm",
      color: chartSeries.amber,
    },
  };
  // MEMBERSHIP from planBodyCharts (age decides which composition charts exist);
  // ORDER from the tab's one ranker — for a growth-tracked profile the life-stage
  // signal lifts height/head-circ above weight, which is the pediatric layout the
  // plan used to encode positionally.
  const compositionCharts: BodyChartSpec[] = applyCardOrder(
    plan.keys.filter((k) => k !== "resting_hr").map((k) => chartByKey[k]),
    cardOrder,
    (c) => c.key
  );

  // Pediatric growth percentiles — returns null unless the profile has a known sex +
  // birthdate and is in chart range. Age-based, so it isn't windowed by the shared
  // range. The card plots the child's WHOLE trajectory, so its inputs are unbounded
  // (ALL_ROWS) — the default 180-row cap silently started the percentile track ~6
  // months ago on a daily-synced child (#399). weightSeries already uses ALL_ROWS.
  const growth = buildGrowthProfile({
    sex: getUserSex(profile.id),
    birthdate: getUserBirthdate(profile.id),
    today: todayStr,
    heights: getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map(
      (r) => ({ date: r.date, value: r.value })
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
    // Weight's unit follows the login's weight preference — the plotted values are
    // converted at the display boundary below (displayWeightGrowth).
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
          // coherent. Other metrics are unit-invariant here.
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

  // ── 4. Synced-from-integrations daily metrics ───────────────────────────────
  // NOT windowed by the shared range; they show the most recent ~6 months (the
  // queries' default 180-row cap), captioned honestly below (issue #399).
  const stepsChart = getMetricDailyTotals(profile.id, "steps").map((r) => ({
    date: r.date,
    value: Math.round(r.value),
  }));
  // Sleep moved to its own dedicated /sleep page (issue #1066): the detailed
  // per-night / regularity / stage cards live there now. Trends → Body keeps a
  // COMPACT summary tile — last night's main-session duration + the SRI — linking to
  // /sleep. Both figures come from the SAME computations the Sleep page reads.
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
  // BMI over the weight series, pairing each weigh-in with the height in effect ON
  // OR BEFORE that date — the SAME date-paired derivation the growth card uses, so
  // the two BMI charts on a child's Body tab can't disagree (issue #407).
  const bmiChart = bmiSeriesDatePaired(
    weightSeries.map((w) => ({ date: w.date, value: w.value })),
    getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map((r) => ({
      date: r.date,
      value: r.value,
    }))
  ).map((p) => ({ date: p.date, value: round(p.value, 1) }));
  // Mood trend (#992): the daily wellbeing check-ins as a chartable 1–5 series —
  // like a vital in shape, but DELIBERATELY never reference-range flagged and never
  // retested (a subjective self-rating, not a lab). Most recent ~6 months.
  const moodChart = getMoodLogs(profile.id, shiftDateStr(todayStr, -179)).map(
    (m) => ({ date: m.date, value: m.valence })
  );

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
    bmiChart.length > 0;

  // #1067 Phase 1 (re-based on #1490): the synced daily charts render from ONE
  // visible list that also feeds the sticky jump chips, so a chip can never point at
  // an absent chart. Membership is each entry's `present` gate; the SEQUENCE is the
  // tab's shared card order. The old per-entry `latestDate`/`order` pair is gone with
  // `orderBodyCharts` — a raw most-recently-synced sort resequenced this page every
  // time a watch uploaded, which is exactly the jitter a stable default forbids.

  const syncedEntries: (ChartChip & {
    present: boolean;
    node: React.ReactNode;
  })[] = [
    {
      id: "steps",
      label: "Steps",
      present: stepsChart.length > 0,
      node: (
        <ChartCard
          key="steps"
          anchorId="steps"
          title="Steps per day"
          detailHref={metricDetailHref("steps")}
          detailTitle="steps"
        >
          <LineChartCard
            data={stepsChart}
            label="Steps"
            color={chartSeries.sky}
          />
        </ChartCard>
      ),
    },
    {
      id: "sleep",
      label: "Sleep",
      present: hasSleep,
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
      node: (
        <ChartCard
          key="hr"
          anchorId="hr"
          title="Heart rate (daily avg)"
          detailHref={metricDetailHref("hr")}
          detailTitle="heart rate"
        >
          <LineChartCard
            data={hrChart}
            label="Avg HR"
            color={chartSeries.rose}
            unit=" bpm"
          />
        </ChartCard>
      ),
    },
    {
      id: "hr-day",
      label: "HR (day)",
      present: hrIntraday.length > 0,
      node: (
        <ChartCard
          key="hr-day"
          anchorId="hr-day"
          className="lg:col-span-2"
          title={`Heart rate over the day${latestHrDay ? ` — ${latestHrDay}` : ""}`}
          // The title carries a DATE, which reads badly in "Open … detail"; the
          // accessible name names the metric instead.
          detailTitle="heart rate"
          detailHref={metricDetailHref("hr")}
        >
          <LineChartCard
            data={hrIntraday}
            label="HR"
            color={chartSeries.rose}
            unit=" bpm"
            showDots={false}
          />
        </ChartCard>
      ),
    },
    {
      id: "bmi",
      label: "BMI",
      present: bmiChart.length > 0,
      node: (
        <ChartCard
          key="bmi"
          anchorId="bmi"
          title="BMI"
          detailHref={metricDetailHref("bmi")}
        >
          <LineChartCard data={bmiChart} label="BMI" color={chartSeries.sky} />
        </ChartCard>
      ),
    },
    {
      id: "lean-mass",
      label: "Lean mass",
      present: leanMassChart.length > 0,
      node: (
        <ChartCard
          key="lean-mass"
          anchorId="lean-mass"
          title="Lean body mass"
          detailHref={metricDetailHref("lean-mass")}
        >
          <LineChartCard
            data={leanMassChart}
            label="Lean mass"
            color={chartSeries.sky}
            unit=" kg"
          />
        </ChartCard>
      ),
    },
    {
      id: "bone-mass",
      label: "Bone mass",
      present: boneMassChart.length > 0,
      node: (
        <ChartCard
          key="bone-mass"
          anchorId="bone-mass"
          title="Bone mass"
          detailHref={metricDetailHref("bone-mass")}
        >
          <LineChartCard
            data={boneMassChart}
            label="Bone mass"
            color={chartSeries.violet}
            unit=" kg"
          />
        </ChartCard>
      ),
    },
    {
      id: "bmr",
      label: "BMR",
      present: bmrChart.length > 0,
      node: (
        <ChartCard
          key="bmr"
          anchorId="bmr"
          title="Basal metabolic rate"
          detailHref={metricDetailHref("bmr")}
        >
          <LineChartCard
            data={bmrChart}
            label="BMR"
            color={chartSeries.rose}
            unit=" kcal"
          />
        </ChartCard>
      ),
    },
    {
      id: "hydration",
      label: "Hydration",
      present: hydrationChart.length > 0,
      node: (
        <ChartCard
          key="hydration"
          anchorId="hydration"
          title="Hydration"
          detailHref={metricDetailHref("hydration")}
        >
          <LineChartCard
            data={hydrationChart}
            label="Water"
            color={chartSeries.sky}
            unit=" L"
          />
        </ChartCard>
      ),
    },
    {
      id: "calories",
      label: "Calories",
      present: caloriesChart.length > 0,
      node: (
        <ChartCard
          key="calories"
          anchorId="calories"
          title="Calories (intake)"
          detailHref={metricDetailHref("calories")}
        >
          <LineChartCard
            data={caloriesChart}
            label="Calories"
            color={chartSeries.amber}
            unit=" kcal"
          />
        </ChartCard>
      ),
    },
  ];
  const orderedSynced = applyCardOrder(
    syncedEntries.filter((e) => e.present),
    cardOrder,
    (e) => e.id
  );

  // ONE presence boolean per fixed section, shared by its chip and its render.
  const hasVitals = vitalsCharts.length > 0 || (intraday && hasIntraday);
  const hasComposition = compositionCharts.some((c) => c.data.length > 0);
  const hasMood = moodChart.length > 0;

  // Jump chips in page reading order: vitals, composition, mood, then the synced
  // charts in their relevance order. ONE list feeds the sticky chip row.
  const jumpChips: ChartChip[] = [
    ...(hasVitals ? [{ id: "vitals", label: "Vitals" }] : []),
    ...(hasComposition ? [{ id: "body-composition", label: "Weight" }] : []),
    ...(hasMood ? [{ id: "mood", label: "Mood" }] : []),
    ...orderedSynced.map((e) => ({ id: e.id, label: e.label })),
  ];

  // Does the growth-percentile card lead the whole stack? Ranked, not forked: true
  // when `growth` outranks every card rendered inside the chart block.
  const growthLeads = growthCardLeads(cardOrder, [
    ...orderedVitals.map((c) => c.key),
    ...compositionCharts.map((c) => c.key),
  ]);

  // The two titled runs of charts, sharing ONE annotation toggle bar (#1486).
  const chartSections: BodyChartSection[] = [
    {
      id: "vitals",
      heading: "Vitals",
      description: intraday
        ? "Today, minute by minute — worn heart rate and any timed blood-pressure or oxygen readings."
        : "Blood pressure, oxygen saturation, respiratory rate, resting heart rate, HRV, and body temperature over the selected window.",
      charts: intraday ? [] : orderedVitals,
      after: intradayBlock,
      empty: (
        <EmptyState message="No vitals logged yet. Add a reading with “+ Log” above to see the trend." />
      ),
    },
    {
      id: "body-composition",
      heading: "Composition",
      description: "Body-composition trends over the selected window.",
      charts: compositionCharts,
    },
  ];

  // ── Tiles ───────────────────────────────────────────────────────────────────
  // Each tile is the 30-day tail of the SAME display-unit series its classic chart
  // draws above (one gather feeds both). The VITALS joined this grid in #1486, so
  // `view=tiles` and `view=all` are two renderings of one metric set — not two
  // different sets. Body fat is dropped for a growth-tracked profile (matching the
  // charts/history); every other metric self-gates on presence.
  const tileSeries: Array<[BodyMetricSlug, Point[]]> = [
    ["systolic", systolicAll],
    ["diastolic", diastolicAll],
    ["spo2", spo2All],
    ["respiratory-rate", respiratoryAll],
    ["resting-hr", restingHrAll],
    ["hrv", hrvAll],
    ["skin-temp", skinTempAll],
    ["temperature", temperatureAll],
    ["weight", weightAll],
    ["body-fat", bodyFatAll],
    ["height", heightAll],
    ["head-circ", headCircAll],
    ["sun", sun],
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
        latestDate: visibleLastNight?.wakeDay ?? null,
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
            {visibleLastNight && lastNightPresentation && (
              <>
                <div className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
                  {formatHm(visibleLastNight.durationMin)}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {lastNightPresentation.label}
                </div>
              </>
            )}
            {sleepReg != null && (
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Regularity · {sriPresentation(sleepReg.sri).text}
              </div>
            )}
            {!visibleLastNight && sleepReg == null && (
              <div className="text-sm text-slate-500 dark:text-slate-400">
                Open Sleep
              </div>
            )}
          </Link>
        ),
      }
    : null;

  return (
    <div className="space-y-6" data-testid="trends-body">
      {/* 1. TODAY — the day's answer comes first, then the way to add to it. */}
      <VitalsTodayStrip rows={todayVitals} date={todayStr} />

      {/* Desktop-only "+ Log" expander over the ONE combined measurements form; on a
          phone this renders nothing and the global quick-log sheet is the path. */}
      <LogMeasurementsPanel
        defaultDate={todayStr}
        weightUnit={wu}
        temperatureUnit={units.temperatureUnit}
        showBodyFat={bodyFatShown}
        showGrowth={showGrowthQuickAdd(ageYears)}
        showHeadCirc={showHeadCircEntry(ageMonths)}
      />

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
        <BodyMetricTiles
          tiles={metricTiles}
          sleep={sleepGridTile}
          order={cardOrder}
        />
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

        {/* For a growth-tracked profile the percentile card is the headline, so it
            floats above the chart sections; adults never have one. That used to be
            planBodyCharts' `growthCardFirst` fork — it is now a CONSEQUENCE of the
            tab's one card order (#1490): the growth card leads exactly when it
            outranks every card inside the chart block. */}
        {growthLeads && growthCard}

        {/* 2 + 3. Vitals then Composition, under ONE annotation toggle bar. */}
        <BodyTrendCharts
          sections={chartSections}
          annotations={annotations}
          windows={protocolWindows}
        />

        {/* 4. Growth charts (minors), then the rest of the reading half. */}
        {!growthLeads && growthCard}

        {/* Mood trend (#992): the daily wellbeing series. Deliberately no reference
            bands, no flags, no retest hooks — mood is not a lab, so a low day is a
            data point, never an "abnormal". Hidden until a check-in exists. */}
        {hasMood && (
          <ChartCard
            anchorId="mood"
            testid="mood-trend"
            title="Mood"
            description="1–5 daily check-ins · most recent ~6 months"
            detailHref={metricDetailHref("mood")}
            footer={
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                A subjective self-rating from your daily check-ins —
                informational only, never range-checked.
              </p>
            }
          >
            <LineChartCard
              data={moodChart}
              label="Mood"
              color={chartSeries.amber}
            />
          </ChartCard>
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
            <EmptyState message="No body metrics yet. Log one with “+ Log” above to see the trend." />
          ) : (
            <ScrollFade>
              <table className="w-full" data-testid="body-history-table">
                <thead>
                  <tr className="border-b border-black/5 dark:border-white/10">
                    <th className="th">Date</th>
                    <th className="th">Weight</th>
                    {bodyFatShown && <th className="th">Body fat</th>}
                    {/* The resting-HR COLUMN stays (#1486): this table is the
                        record EDITOR, not a second chart of the metric. */}
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
