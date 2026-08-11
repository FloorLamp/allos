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
  getProfileSex,
  getProfileBirthdate,
  getProfileAge,
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
  getManualBodyMetricStatedAt,
  getDaylightOutdoorMinutesSeries,
  getMetricDailyTotals,
  getSleepDurationTrend,
  getSleepRegularityInRange,
  getSleepSummaryInRange,
  getHrDailySummary,
  getLatestHrDay,
  getHrMinutes,
  getOutcomeGoals,
  getMoodLogs,
  buildTrendsSubjectContext,
  getBodyCardPins,
} from "@/lib/queries";
import { dispWeight, fmtWeight, round } from "@/lib/units";
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "@/lib/vitals-input";
import { bmiSeriesDatePaired } from "@/lib/growth-series";
import { buildGrowthTrendPresentation } from "@/lib/growth-trend-views";
import { ordinalPercentile } from "@/lib/growth-format";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { dayFillWindow } from "@/lib/day-fill";
import { metricSeriesKey } from "@/lib/saved-items";
import {
  SLEEP_DURATION_SERIES_KEY,
  type DayFillSpec,
} from "@/lib/trend-sparkline";
import { applyCardOrder, bodyCardOrder } from "@/lib/trends-card-rank";
import {
  TREND_METRIC_META,
  trendMetricChartScale,
  buildTrendMetricTile,
  savedMetricIdForTrendSlug,
  stableEmptyLast,
  type TrendMetricSlug,
  type TrendMetricTile,
  type CheckInMetricSlug,
} from "@/lib/trend-metrics";
import { moodSeriesPoints } from "@/lib/mood";
import { isAnxietyScaleRelevant } from "@/lib/queries/mood-anxiety";
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
import { isGoalLive } from "@/lib/outcome-goals";
import { isIntradayRange, type DateRange } from "@/lib/timeline-format";
import {
  GROWTH_TRENDS_HREF,
  growthTrendsHref,
  metricDetailHref,
  timelineDayHref,
  type AppRoute,
} from "@/lib/hrefs";
import type {
  BodyMetricKind,
  OutcomeGoal,
  ClinicalObservation,
} from "@/lib/types";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import ChartCard, { CHART_PLOT_FILL } from "@/components/ChartCard";
import TrendMiniCard from "@/components/TrendMiniCard";
import NotesText from "@/components/NotesText";
import ScrollFade from "@/components/ScrollFade";
import TrendMetricCharts, {
  type TrendChartSpec,
  type TrendStackItem,
} from "@/components/TrendMetricCharts";
import GrowthChartsCard from "@/components/GrowthChartsCard";
import LogMeasurementsPanel from "./LogMeasurementsPanel";
import VitalsTodayStrip from "./VitalsTodayStrip";
import type { ChartChip } from "./ChartJumpChips";
import ChartJumpMenu from "./ChartJumpMenu";
import TrendMetricTiles from "./TrendMetricTiles";
import BodyViewToggle from "./BodyViewToggle";
import {
  tilesContainerClass,
  stackContainerClass,
  type BodyView,
} from "./body-view";
import DeleteBodyMetricButton from "./DeleteBodyMetricButton";
import EditLockNotice from "@/components/EditLockNotice";
import BodyHygieneFindings from "./BodyHygieneFindings";

// The Trends hub's **Body** census — the ONE physiology surface (issue #1486).
//
// Trends carried a Vitals tab and a body census that answered the same question about
// the same person from the same rows: "what is my body doing". A blood pressure was
// on one, a weight on the other, and resting heart rate was on BOTH (charted twice,
// with a goal overlay on only one of them). #1486 retires the Vitals tab into this
// one, in the order a reader actually wants:
//
//   1. **Today** — today's body composition + latest vital readings (the evolved
//      #1466 strip), plus the 1D pill's intraday swap and the desktop "+ Log"
//      expander.
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
// #1644 retired the Body TAB: this census is the third part of the Trends landing
// surface (digest → starred grid → here), reachable at `/trends#body` and streamed
// into its own Suspense boundary so the head never waits on the ~30 reads below.
// Nothing about the census itself changed — same skeleton, same membership gates,
// same ★-first-then-ranked order. Fitness, Nutrition and Insights stay tabs.

type Point = { date: string; value: number };

// medical_records vitals (BP / SpO2 / respiratory rate / temperature) — one value
// per reading, mapped to the {date,value} the chart takes.
function vitalPoints(rows: ClinicalObservation[], decimals = 0): Point[] {
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
//
// EXCEPT today's, optionally (#2235): when the day's number is one physical row's
// reading and that row states an `occurred_at`, the strip may honestly say "at
// 07:12" — so the caller can attach that one stated instant to the matching entry.
// It never invents one: a fold of several rows keeps rendering "today".
function dailyRows(
  series: Point[],
  todayAt?: { date: string; occurredAt: string | null }
): VitalReadingRow[] {
  return series.map((d) =>
    todayAt && d.date === todayAt.date && todayAt.occurredAt
      ? { date: d.date, value_num: d.value, occurred_at: todayAt.occurredAt }
      : { date: d.date, value_num: d.value }
  );
}

// Fahrenheit fever threshold (100.4 °F / 38 °C) — the reference line on the acute
// temperature view, matching the illness/fever surface (#859).
const FEVER_F = 100.4;
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
  // The 1D pill's window (from == to == today). Only the landing surface offers
  // that pill, because only this census has intraday content to swap in.
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

  // Keep the UNWINDOWED display-unit series named (…All) so the overview tiles and
  // charts apply the shared range to the SAME arrays — one gather feeds both (#221).
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
  const stepsAll = getMetricDailyTotals(profile.id, "steps", ALL_ROWS).map(
    (r) => ({
      date: r.date,
      value: Math.round(r.value),
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

  // Age drives chart MEMBERSHIP: for a growth-tracked profile the tab charts height
  // (and head circ for the very young) and drops body fat entirely. That decision
  // stays the pure lib/growth-metrics (planBodyCharts), shared with tests.
  //
  // The ORDER those charts render in is no longer decided here (#1490). Every card
  // on this tab is sequenced by ONE ranker (lib/trends-card-rank.ts) over STABLE
  // subject facts — life stage, live goals, monitored conditions, data presence —
  // so the old hand-rolled forks (planBodyCharts' `growthCardFirst` and the
  // trends-body-order recency sort) are one signal table now instead of two
  // per-surface rules.
  //
  // The USER's half of that order is the ★ (#1643): the profile's starred cards lead
  // in their SAVED order — the same `saved_items` sequence the Overview grid's drag
  // and ⋯-menu arrows write — and the ranker sequences everything unpinned. There is
  // no second arrangement store; #1490's writerless `trends_card_order` key retired
  // with this change.
  const ageYears = getProfileAge(profile.id);
  const birthdate = getProfileBirthdate(profile.id);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, todayStr)
    : null;
  const plan = planBodyCharts({ ageYears, ageMonths });
  const pins = getBodyCardPins(profile.id);
  const cardOrder = bodyCardOrder(
    buildTrendsSubjectContext(profile.id, todayStr),
    getBodyCardPins(profile.id)
  );

  // WHERE THE ★ LIVES ON THIS TAB (#1643). Nowhere new — and that is the decision,
  // not an omission. Every card here already taps through to its metric detail page
  // (#1488's contract: the card's header IS one edge-to-edge target), and that page
  // has carried the shipped ★ since #1456 for every registered trend slug. So the
  // pinning gesture is one tap from every card in the census, through the affordance
  // the card already promises.
  //
  // A corner ⋯ menu on each card was the obvious alternative and is the wrong trade:
  // on a Body chart card and on a Body tile it takes ~40px out of exactly the link
  // #1488 measures (e2e/chart-tap-through.spec.ts holds both to ≥95% of the card
  // width), so twenty cards would pay a real tap-target cost for a second route to a
  // gesture that is already one tap away. Overview's tiles keep their menu because
  // membership is what that grid is for. The hint under the census names the path.
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
  // metric wins (getOutcomeGoals returns active-first).
  const goals = getOutcomeGoals(profile.id);
  const goalFor = (metric: BodyMetricKind): OutcomeGoal | undefined =>
    goals.find(
      (g) => g.body_metric === metric && isGoalLive(g) && g.target_value != null
    );

  const goalOverlay = (
    metric: BodyMetricKind,
    data: Point[],
    unit: string,
    decimals: number
  ): Pick<TrendChartSpec, "referenceValue" | "projectionNote"> => {
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
  // A formatter over the arrays above. Body-composition rows already carry the
  // source-prioritized daily rollup; raw vitals resolve their latest clock time.
  // Oxygen saturation and respiratory rate stay in the Vitals charts/detail
  // surface, but are deliberately omitted here so this concise snapshot leads
  // with composition + core readings.
  //
  // The stated time for today's composition cells (#2235): honest ONLY when the
  // day's number is one physical row's reading — then that row's `occurred_at` is
  // the time the value was taken and the cell may say "at 07:12". When several
  // rows fold into the number (two devices, or a legacy stacked manual day), no
  // single instant describes it, so the cell keeps its day-grain "today" rather
  // than borrowing one row's clock for a blended value. Display only — nothing
  // ranks, filters, or schedules off this (constraint 2).
  const soleTodayOccurredAt = (
    col: "weight_kg" | "body_fat_pct" | "resting_hr"
  ): { date: string; occurredAt: string | null } => {
    const rows = bodyMetrics.filter(
      (r) => r.date === todayStr && r[col] != null
    );
    return {
      date: todayStr,
      occurredAt: rows.length === 1 ? (rows[0].occurred_at ?? null) : null,
    };
  };
  const todayVitals = buildTodayVitalsStrip(
    [
      {
        key: "weight",
        label: TREND_METRIC_META.weight.title,
        unit: wu,
        rows: dailyRows(weightAll, soleTodayOccurredAt("weight_kg")),
        decimals: 1,
      },
      ...(bodyFatShown
        ? [
            {
              key: "body-fat",
              label: TREND_METRIC_META["body-fat"].title,
              unit: "%",
              rows: dailyRows(bodyFatAll, soleTodayOccurredAt("body_fat_pct")),
              decimals: 1,
            },
          ]
        : []),
      {
        key: "steps",
        label: TREND_METRIC_META.steps.title,
        unit: "steps",
        rows: dailyRows(stepsAll),
        groupThousands: true,
      },
      {
        key: "bp",
        label:
          TREND_METRIC_META.systolic.summaryTitle ??
          TREND_METRIC_META.systolic.title,
        unit: "mmHg",
        rows: systolicRows,
        pairRows: diastolicRows,
      },
      {
        key: "resting-hr",
        label: TREND_METRIC_META["resting-hr"].title,
        unit: "bpm",
        rows: dailyRows(restingHrAll, soleTodayOccurredAt("resting_hr")),
      },
      {
        key: "temperature",
        label: TREND_METRIC_META.temperature.title,
        unit: "°F",
        rows: temperatureRows,
        decimals: 1,
      },
      {
        key: "hrv",
        label: TREND_METRIC_META.hrv.title,
        unit: "ms",
        rows: dailyRows(hrvAll),
      },
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
  const vitalsCharts: TrendChartSpec[] = [];
  if (systolicAll.length > 0) {
    vitalsCharts.push({
      key: "systolic",
      testid: "vitals-systolic",
      detailHref: metricDetailHref("systolic"),
      title: TREND_METRIC_META.systolic.title,
      data: systolicChart,
      unit: " mmHg",
      color: chartSeries.rose,
    });
  }
  if (diastolicAll.length > 0) {
    vitalsCharts.push({
      key: "diastolic",
      testid: "vitals-diastolic",
      detailHref: metricDetailHref("diastolic"),
      title: TREND_METRIC_META.diastolic.title,
      data: diastolicChart,
      unit: " mmHg",
      color: chartSeries.violet,
    });
  }
  if (spo2All.length > 0) {
    vitalsCharts.push({
      key: "spo2",
      testid: "vitals-spo2",
      detailHref: metricDetailHref("spo2"),
      title: TREND_METRIC_META.spo2.title,
      data: spo2Chart,
      unit: "%",
      color: chartSeries.sky,
    });
  }
  if (respiratoryAll.length > 0) {
    vitalsCharts.push({
      key: "respiratory-rate",
      testid: "vitals-respiratory-rate",
      detailHref: metricDetailHref("respiratory-rate"),
      title: TREND_METRIC_META["respiratory-rate"].title,
      data: respiratoryChart,
      unit: " /min",
      color: chartSeries.violet,
    });
  }
  if (restingHrAll.length > 0) {
    // Resting HR appears EXACTLY ONCE (#1486): the body census old copy retired and
    // its goal overlay + the shared event annotations came here with it.
    vitalsCharts.push({
      key: "resting_hr",
      testid: "vitals-resting-hr",
      detailHref: metricDetailHref("resting-hr"),
      title: TREND_METRIC_META["resting-hr"].title,
      data: restingHrChart,
      unit: " bpm",
      color: chartSeries.amber,
      ...goalOverlay("resting_hr", restingHrChart, " bpm", 0),
    });
  }
  if (hrvAll.length > 0) {
    vitalsCharts.push({
      key: "hrv",
      testid: "vitals-hrv",
      detailHref: metricDetailHref("hrv"),
      title: TREND_METRIC_META.hrv.title,
      data: hrvChart,
      unit: " ms",
      color: chartSeries.amber,
    });
  }
  if (skinTempAll.length > 0) {
    vitalsCharts.push({
      key: "skin_temp",
      testid: "vitals-skin-temp",
      detailHref: metricDetailHref("skin-temp"),
      title: TREND_METRIC_META["skin-temp"].title,
      data: skinTempChart,
      unit: TREND_METRIC_META["skin-temp"].unit,
      color: TREND_METRIC_META["skin-temp"].color,
      note: "Nightly deviation from your tracker's own baseline, not an absolute temperature — so only the change matters, and it is comparable to your other nights rather than to a reference range. A sustained rise often shows up alongside a drop in HRV.",
    });
  }
  if (sun.length > 0) {
    vitalsCharts.push({
      key: "sun",
      testid: "vitals-sun-outdoor",
      detailHref: metricDetailHref("sun"),
      title: TREND_METRIC_META.sun.title,
      data: sun,
      unit: " min",
      color: chartSeries.amber,
      note: "Daylight minutes from your outdoor sessions, scoped to the solar day at your home location. The same figure the day view's sun chip shows.",
    });
  }
  if (temperatureAll.length > 0) {
    // Temperature keeps its acute fever reference and illness link, but the plotted
    // readings still obey the selected window like every other Body chart.
    vitalsCharts.push({
      key: "temperature",
      testid: "vitals-temperature",
      detailHref: metricDetailHref("temperature"),
      title: TREND_METRIC_META.temperature.title,
      data: filterSeriesByRange(temperatureAll, range),
      unit: " °F",
      color: chartSeries.rose,
      referenceValue: { value: FEVER_F, label: "Fever" },
      note: "Temperature is an acute signal — a fever is tracked on the illness/fever chart, not interpreted as a slow long-term trajectory.",
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

  // MEMBERSHIP only: each vitals card above is present-gated on its own series.
  // ORDER is the flat stack's job (#1674) — one ranking pass over every member,
  // rather than a per-run sort inside a box that the boxes then re-ordered.

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
            title={`${TREND_METRIC_META.hr.summaryTitle ?? TREND_METRIC_META.hr.title} Today`}
            headingLevel="h3"
            detailHref={metricDetailHref("hr")}
            detailTitle="heart rate"
            surfaceClass={FULL_BLEED_CARD}
            headerClassName="px-4 sm:px-0"
            headerBleedClassName="mx-0 mt-0 sm:-mx-5 sm:-mt-5"
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
                // gap-exempt: an intraday clock axis (HH:MM slots), not calendar
                // days — lib/intraday.ts already slots and breaks its own gaps.
                data={intradayHr}
                label={`${TREND_METRIC_META.hr.summaryTitle ?? TREND_METRIC_META.hr.title} Today`}
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
              title={`${TREND_METRIC_META.systolic.title} Today`}
              headingLevel="h3"
              detailHref={metricDetailHref("systolic")}
              detailTitle="systolic blood pressure"
              testid="vitals-intraday-bp"
              plotHeightClass={INTRADAY_POINT_PLOT_HEIGHT}
            >
              <LineChartCard
                // gap-exempt: intraday HH:MM slot grid, already null-slotted.
                data={toIntradaySlotSeries(intradaySystolic)}
                label={`${TREND_METRIC_META.systolic.title} Today`}
                unit=" mmHg"
                color={chartSeries.rose}
                connectNulls={false}
              />
            </ChartCard>
            <ChartCard
              title={`${TREND_METRIC_META.diastolic.title} Today`}
              headingLevel="h3"
              detailHref={metricDetailHref("diastolic")}
              detailTitle="diastolic blood pressure"
              testid="vitals-intraday-bp-diastolic"
              plotHeightClass={INTRADAY_POINT_PLOT_HEIGHT}
            >
              <LineChartCard
                // gap-exempt: intraday HH:MM slot grid, already null-slotted.
                data={toIntradaySlotSeries(intradayDiastolic)}
                label={`${TREND_METRIC_META.diastolic.title} Today`}
                unit=" mmHg"
                color={chartSeries.violet}
                connectNulls={false}
              />
            </ChartCard>
          </div>
        )}

        {intradaySpo2.length > 0 && (
          <ChartCard
            title={`${TREND_METRIC_META.spo2.title} Today`}
            headingLevel="h3"
            detailHref={metricDetailHref("spo2")}
            detailTitle="oxygen saturation"
            testid="vitals-intraday-spo2"
            plotHeightClass={INTRADAY_POINT_PLOT_HEIGHT}
          >
            <LineChartCard
              // gap-exempt: intraday HH:MM slot grid, already null-slotted.
              data={toIntradaySlotSeries(intradaySpo2)}
              label={`${TREND_METRIC_META.spo2.title} Today`}
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
  const chartByKey: Record<BodyChartKey, TrendChartSpec> = {
    height: {
      key: "height",
      testid: "body-chart-height",
      detailHref: metricDetailHref("height"),
      title: TREND_METRIC_META.height.title,
      data: heightChart,
      unit: " cm",
      color: chartSeries.violet,
    },
    head_circumference: {
      key: "head_circumference",
      testid: "body-chart-head-circ",
      detailHref: metricDetailHref("head-circ"),
      title: TREND_METRIC_META["head-circ"].title,
      data: headCircChart,
      unit: " cm",
      color: chartSeries.sky,
    },
    weight: {
      key: "weight",
      testid: "body-chart-weight",
      detailHref: metricDetailHref("weight"),
      title: TREND_METRIC_META.weight.title,
      data: weightChart,
      unit: ` ${wu}`,
      color: chartSeries.brand,
      ...goalOverlay("weight", weightChart, ` ${wu}`, 1),
      // Contextual entry to the bulk-correction panel (#1603): a bad RUN in this
      // chart (miscalibrated scale, lb-as-kg import) is fixed in one pass on
      // Data → Review, not row-at-a-time. A FOOTER action, not a headerAction:
      // the header row is the card's full-width tap target (#1488, pinned by
      // chart-tap-through.spec) and must not cede width to a sibling affordance.
      footerAction: (
        <Link
          href="/data?section=review&fix=weight#bulk-correction"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          data-testid="body-weight-fix-range"
        >
          Fix a range <IconArrowRight size={14} />
        </Link>
      ),
    },
    bodyfat: {
      key: "bodyfat",
      testid: "body-chart-bodyfat",
      detailHref: metricDetailHref("body-fat"),
      title: TREND_METRIC_META["body-fat"].title,
      data: bodyFatChart,
      unit: "%",
      color: chartSeries.violet,
      ...goalOverlay("body_fat", bodyFatChart, "%", 1),
    },
    // Kept in the map (planBodyCharts still names it) but filtered OUT below — the
    // vitals section is resting HR's one home now.
    resting_hr: {
      key: "resting_hr",
      detailHref: metricDetailHref("resting-hr"),
      title: TREND_METRIC_META["resting-hr"].title,
      data: restingHrChart,
      unit: " bpm",
      color: chartSeries.amber,
    },
  };
  // MEMBERSHIP from planBodyCharts (age decides which composition charts exist).
  // ORDER is the flat stack's, like every other member (#1674) — for a
  // growth-tracked profile the life-stage signal lifts height/head-circ above
  // weight there, which is the pediatric layout the plan used to encode
  // positionally.
  const compositionCharts: TrendChartSpec[] = plan.keys
    .filter((k) => k !== "resting_hr")
    .map((k) => chartByKey[k]);

  // Pediatric growth percentiles — returns null unless the profile has a known sex +
  // birthdate and is in chart range. Age-based, so it isn't windowed by the shared
  // range. The card plots the child's WHOLE trajectory, so its inputs are unbounded
  // (ALL_ROWS) — the default 180-row cap silently started the percentile track ~6
  // months ago on a daily-synced child (#399). weightSeries already uses ALL_ROWS.
  const growthPresentation = buildGrowthTrendPresentation({
    sex: getProfileSex(profile.id),
    birthdate: getProfileBirthdate(profile.id),
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
    weightUnit: wu,
    range,
  });
  const growthCard = growthPresentation ? (
    <GrowthChartsCard
      views={growthPresentation.views}
      currentAgeMonths={growthPresentation.currentAgeMonths}
      source={growthPresentation.source}
      detailHref={GROWTH_TRENDS_HREF}
      range={range}
    />
  ) : null;

  // ── 4. Synced-from-integrations daily metrics ───────────────────────────────
  // Full series stay named `…All` for presence and tile construction. Every plot
  // is windowed by the one shared range below — no private "recent N" exception.
  const stepsChart = filterSeriesByRange(stepsAll, range);
  const activeCaloriesAll = getMetricDailyTotals(
    profile.id,
    "active_kcal",
    ALL_ROWS
  ).map((r) => ({
    date: r.date,
    value: Math.round(r.value),
  }));
  const activeCaloriesChart = filterSeriesByRange(activeCaloriesAll, range);
  // Sleep keeps its detailed regularity / stage analysis on /sleep, while Trends →
  // Body charts the nightly main-session duration like its neighboring metrics.
  // Convert minutes to hours at this display boundary; storage and the shared sleep
  // query remain minute-based.
  const sleepDurationAll = getSleepDurationTrend(profile.id, 3650).map(
    (night) => ({
      date: night.date,
      value: round(night.value / 60, 1),
    })
  );
  const sleepDurationChart = filterSeriesByRange(sleepDurationAll, range);
  const lastNight = getSleepSummaryInRange(profile.id, range);
  const lastNightPresentation = lastNight
    ? sleepRecordPresentation(lastNight.wakeDay, todayStr, formatPrefs)
    : null;
  const visibleLastNight = lastNight;
  const sleepReg = getSleepRegularityInRange(profile.id, range);
  const hasSleep = sleepDurationAll.length > 0;
  const sleepDateLabel =
    visibleLastNight &&
    (lastNightPresentation?.freshness === "stale" ||
      (range.to != null && range.to < todayStr))
      ? formatLongDate(visibleLastNight.wakeDay, formatPrefs)
      : lastNightPresentation?.label;
  const leanMassAll = getMetricDailyTotals(
    profile.id,
    "lean_mass_kg",
    ALL_ROWS
  ).map((r) => ({ date: r.date, value: round(r.value, 1) }));
  const leanMassChart = filterSeriesByRange(leanMassAll, range);
  const boneMassAll = getMetricDailyTotals(
    profile.id,
    "bone_mass_kg",
    ALL_ROWS
  ).map((r) => ({ date: r.date, value: round(r.value, 2) }));
  const boneMassChart = filterSeriesByRange(boneMassAll, range);
  const bmrAll = getMetricDailyTotals(profile.id, "bmr_kcal", ALL_ROWS).map(
    (r) => ({ date: r.date, value: Math.round(r.value) })
  );
  const bmrChart = filterSeriesByRange(bmrAll, range);
  const hydrationAll = getMetricDailyTotals(
    profile.id,
    "hydration_l",
    ALL_ROWS
  ).map((r) => ({ date: r.date, value: round(r.value, 2) }));
  const hydrationChart = filterSeriesByRange(hydrationAll, range);
  const caloriesAll = getMetricDailyTotals(
    profile.id,
    "nutrition_kcal",
    ALL_ROWS
  ).map((r) => ({ date: r.date, value: Math.round(r.value) }));
  const caloriesChart = filterSeriesByRange(caloriesAll, range);
  // BMI over the weight series, pairing each weigh-in with the height in effect ON
  // OR BEFORE that date — the SAME date-paired derivation the growth card uses, so
  // the two BMI charts on a child's body census can't disagree (issue #407).
  const bmiAll = bmiSeriesDatePaired(
    weightSeries.map((w) => ({ date: w.date, value: w.value })),
    getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map((r) => ({
      date: r.date,
      value: r.value,
    }))
  ).map((p) => ({ date: p.date, value: round(p.value, 1) }));
  const bmiChart = filterSeriesByRange(bmiAll, range);
  // Check-in trends (#992, completed by #1408): the daily wellbeing check-ins as
  // chartable 1–5 series — like a vital in shape, but DELIBERATELY never
  // reference-range flagged and never retested (subjective self-ratings, not labs).
  //
  // ONE read of the mood rows feeds all THREE series through the one pure mapper
  // (#221). The check-in has always stored energy and anxiety beside valence and
  // plotted only valence; these are the two that had nowhere to be reviewed. `calm`
  // arrives on its #1313 display axis (high = calm), matching the card's own scale.
  const moodLogs = getMoodLogs(profile.id);
  const moodAll = moodSeriesPoints(moodLogs, "valence");
  const moodChart = filterSeriesByRange(moodAll, range);
  const energyAll = moodSeriesPoints(moodLogs, "energy");
  const energyChart = filterSeriesByRange(energyAll, range);
  const calmAll = moodSeriesPoints(moodLogs, "calm");
  const calmChart = filterSeriesByRange(calmAll, range);

  const hrAll = getHrDailySummary(profile.id, 3650).map((r) => ({
    date: r.date,
    value: Math.round(r.avg),
  }));
  const hrChart = filterSeriesByRange(hrAll, range);
  const latestHrDay = getLatestHrDay(profile.id);
  // The clock zoom belongs to the selected window just like every neighboring
  // chart. Do not surface an old "latest day" while the user is inspecting a
  // different range.
  const latestHrDayInRange =
    latestHrDay != null &&
    filterSeriesByRange([{ date: latestHrDay, value: 0 }], range).length > 0;
  const hrIntraday =
    latestHrDay && latestHrDayInRange
      ? getHrMinutes(profile.id, latestHrDay).map((m) => ({
          date: m.ts.slice(11), // HH:MM
          value: round(m.bpm, 0),
        }))
      : [];
  const hasSynced =
    stepsAll.length > 0 ||
    activeCaloriesAll.length > 0 ||
    hasSleep ||
    hrAll.length > 0 ||
    leanMassAll.length > 0 ||
    boneMassAll.length > 0 ||
    bmrAll.length > 0 ||
    hydrationAll.length > 0 ||
    caloriesAll.length > 0 ||
    bmiAll.length > 0;

  // #1067 Phase 1 (re-based on #1490): the synced daily charts render from ONE
  // visible list that also feeds the chart menu, so it can never point at
  // an absent chart. Membership is each entry's `present` gate; the SEQUENCE is the
  // tab's shared card order. The old per-entry `latestDate`/`order` pair is gone with
  // `orderBodyCharts` — a raw most-recently-synced sort resequenced this page every
  // time a watch uploaded, which is exactly the jitter a stable default forbids.

  // Every day-grain chart on this page densifies to the CALENDAR (#2258): the
  // series names itself, the shared range supplies the window, and the per-series
  // gap registry decides whether a missing day is a hole or a real zero. One
  // helper so a card and its tile can never be windowed differently.
  const bodyGapFill = (slug: TrendMetricSlug): DayFillSpec => ({
    seriesKey: metricSeriesKey(savedMetricIdForTrendSlug(slug)),
    ...dayFillWindow(range),
  });
  // Sleep duration is plotted here and on /sleep; it is a per-night READING, so it
  // declares its policy under the shared render-only key rather than by hand.
  const sleepGapFill: DayFillSpec = {
    seriesKey: SLEEP_DURATION_SERIES_KEY,
    ...dayFillWindow(range),
  };

  const syncedEntries: (ChartChip & {
    present: boolean;
    node: React.ReactNode;
  })[] = [
    {
      id: "steps",
      label: TREND_METRIC_META.steps.title,
      present: stepsAll.length > 0,
      node: (
        <ChartCard
          key="steps"
          anchorId="steps"
          title={TREND_METRIC_META.steps.title}
          detailHref={metricDetailHref("steps")}
          detailTitle="steps"
        >
          {/* Count metric: zero-floored axis + grouped ticks, from the ONE
              registry the detail page reads (#1541). */}
          <LineChartCard
            data={stepsChart}
            label={TREND_METRIC_META.steps.title}
            color={chartSeries.sky}
            gapFill={bodyGapFill("steps")}
            {...trendMetricChartScale(TREND_METRIC_META.steps)}
          />
        </ChartCard>
      ),
    },
    {
      id: "active-calories",
      label: TREND_METRIC_META["active-calories"].title,
      present: activeCaloriesAll.length > 0,
      node: (
        <ChartCard
          key="active-calories"
          anchorId="active-calories"
          title={TREND_METRIC_META["active-calories"].title}
          detailHref={metricDetailHref("active-calories")}
        >
          <LineChartCard
            data={activeCaloriesChart}
            label={TREND_METRIC_META["active-calories"].title}
            color={chartSeries.rose}
            gapFill={bodyGapFill("active-calories")}
            unit=" kcal"
            {...trendMetricChartScale(TREND_METRIC_META["active-calories"])}
          />
        </ChartCard>
      ),
    },
    {
      id: "sleep",
      label: "Sleep",
      present: hasSleep,
      node: (
        <ChartCard
          key="sleep"
          anchorId="sleep"
          title="Sleep"
          headline={
            visibleLastNight
              ? formatHm(visibleLastNight.durationMin)
              : sleepDurationChart.length > 0
                ? `${sleepDurationChart.at(-1)?.value} h`
                : undefined
          }
          description="Nightly Sleep Duration"
          detailHref="/sleep"
          detailTitle="Sleep"
          testid="sleep-summary-tile"
          footer={
            visibleLastNight || sleepReg != null ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                {visibleLastNight && sleepDateLabel && (
                  <span>
                    {sleepDateLabel}
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
                  </span>
                )}
                {sleepReg != null && (
                  <span data-testid="sleep-regularity">
                    Regularity ·{" "}
                    <span data-testid="sri-value">
                      {sriPresentation(sleepReg.sri).text}
                    </span>
                  </span>
                )}
              </div>
            ) : undefined
          }
        >
          <LineChartCard
            data={sleepDurationChart}
            label="Sleep"
            unit=" h"
            color={chartSeries.violet}
            decimals={1}
            gapFill={sleepGapFill}
          />
        </ChartCard>
      ),
    },
    {
      id: "hr",
      label: TREND_METRIC_META.hr.title,
      present: hrAll.length > 0,
      node: (
        <ChartCard
          key="hr"
          anchorId="hr"
          title={TREND_METRIC_META.hr.title}
          detailHref={metricDetailHref("hr")}
          detailTitle="heart rate"
        >
          <LineChartCard
            data={hrChart}
            label={TREND_METRIC_META.hr.title}
            color={chartSeries.rose}
            unit=" bpm"
            gapFill={bodyGapFill("hr")}
          />
        </ChartCard>
      ),
    },
    {
      id: "hr-day",
      label: `${TREND_METRIC_META.hr.summaryTitle ?? TREND_METRIC_META.hr.title} (Intraday)`,
      // A single worn-HR sample cannot form an intraday trend. With dots hidden it
      // painted as a large blank chart, so keep the useful daily summary and omit
      // this zoom until there is an actual line to read.
      present: hrIntraday.length > 1,
      node: (
        <ChartCard
          key="hr-day"
          anchorId="hr-day"
          className="lg:col-span-2"
          title={`${TREND_METRIC_META.hr.summaryTitle ?? TREND_METRIC_META.hr.title} Over the Day${latestHrDay ? ` — ${latestHrDay}` : ""}`}
          // The title carries a DATE, which reads badly in "Open … detail"; the
          // accessible name names the metric instead.
          detailTitle="heart rate"
          detailHref={metricDetailHref("hr")}
        >
          <LineChartCard
            // gap-exempt: the per-minute intraday zoom, an HH:MM axis.
            data={hrIntraday}
            label={`${TREND_METRIC_META.hr.summaryTitle ?? TREND_METRIC_META.hr.title} Over the Day${
              latestHrDay ? ` — ${latestHrDay}` : ""
            }`}
            color={chartSeries.rose}
            unit=" bpm"
            showDots={false}
          />
        </ChartCard>
      ),
    },
    {
      id: "bmi",
      label: TREND_METRIC_META.bmi.title,
      present: bmiAll.length > 0,
      node: (
        <ChartCard
          key="bmi"
          anchorId="bmi"
          title={TREND_METRIC_META.bmi.title}
          detailHref={metricDetailHref("bmi")}
        >
          <LineChartCard
            data={bmiChart}
            label={TREND_METRIC_META.bmi.title}
            color={chartSeries.sky}
            gapFill={bodyGapFill("bmi")}
          />
        </ChartCard>
      ),
    },
    {
      id: "lean-mass",
      label: TREND_METRIC_META["lean-mass"].title,
      present: leanMassAll.length > 0,
      node: (
        <ChartCard
          key="lean-mass"
          anchorId="lean-mass"
          title={TREND_METRIC_META["lean-mass"].title}
          detailHref={metricDetailHref("lean-mass")}
        >
          <LineChartCard
            data={leanMassChart}
            label={TREND_METRIC_META["lean-mass"].title}
            color={chartSeries.sky}
            unit=" kg"
            gapFill={bodyGapFill("lean-mass")}
          />
        </ChartCard>
      ),
    },
    {
      id: "bone-mass",
      label: TREND_METRIC_META["bone-mass"].title,
      present: boneMassAll.length > 0,
      node: (
        <ChartCard
          key="bone-mass"
          anchorId="bone-mass"
          title={TREND_METRIC_META["bone-mass"].title}
          detailHref={metricDetailHref("bone-mass")}
        >
          <LineChartCard
            data={boneMassChart}
            label={TREND_METRIC_META["bone-mass"].title}
            color={chartSeries.violet}
            unit=" kg"
            gapFill={bodyGapFill("bone-mass")}
          />
        </ChartCard>
      ),
    },
    {
      id: "bmr",
      label: TREND_METRIC_META.bmr.title,
      present: bmrAll.length > 0,
      node: (
        <ChartCard
          key="bmr"
          anchorId="bmr"
          title={TREND_METRIC_META.bmr.title}
          detailHref={metricDetailHref("bmr")}
        >
          <LineChartCard
            data={bmrChart}
            label={TREND_METRIC_META.bmr.title}
            color={chartSeries.rose}
            unit=" kcal"
            gapFill={bodyGapFill("bmr")}
          />
        </ChartCard>
      ),
    },
    {
      id: "hydration",
      label: TREND_METRIC_META.hydration.title,
      present: hydrationAll.length > 0,
      node: (
        <ChartCard
          key="hydration"
          anchorId="hydration"
          title={TREND_METRIC_META.hydration.title}
          detailHref={metricDetailHref("hydration")}
        >
          <LineChartCard
            data={hydrationChart}
            label={TREND_METRIC_META.hydration.title}
            color={chartSeries.sky}
            unit=" L"
            gapFill={bodyGapFill("hydration")}
            {...trendMetricChartScale(TREND_METRIC_META.hydration)}
          />
        </ChartCard>
      ),
    },
    {
      id: "calories",
      label: TREND_METRIC_META.calories.title,
      present: caloriesAll.length > 0,
      node: (
        <ChartCard
          key="calories"
          anchorId="calories"
          title={TREND_METRIC_META.calories.title}
          detailHref={metricDetailHref("calories")}
        >
          <LineChartCard
            data={caloriesChart}
            label={TREND_METRIC_META.calories.title}
            color={chartSeries.amber}
            unit=" kcal"
            gapFill={bodyGapFill("calories")}
            {...trendMetricChartScale(TREND_METRIC_META.calories)}
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

  // ONE presence boolean per block, shared by its menu item and its render.
  const hasMood = moodAll.length > 0;
  const hasEnergy = energyAll.length > 0;
  // Calm carries the INPUT's gate as well as presence (#1313/#1408): a trend must
  // never be the thing that surfaces an anxiety scale to a profile the card itself
  // wouldn't offer it to. In practice presence implies relevance — prior use is the
  // gate's first signal, so any profile with an anxiety rating already passes — and
  // the resolver is only consulted when there IS something to plot, so a profile
  // that never used the scale pays nothing. The two are asserted together anyway,
  // because "the trend follows the card" must survive a future change to either.
  const hasCalm = calmAll.length > 0 && isAnxietyScaleRelevant(profile.id);

  // ── The FLAT ranked stack (#1674) ───────────────────────────────────────────
  // The census used to render titled runs ("Vitals", "Composition") ordered as
  // wholes by best member, with the synced-daily grid below them and outside the
  // ordering entirely. That was a SECOND source of truth for order next to the
  // ranker, and it contradicted the first: SpO₂ rode above steps inside the Vitals
  // box (its everyday-tier neighbours lifted the whole box), steps could not
  // compete at all, and #1643's contiguous starred run was unsatisfiable — three
  // stars in three boxes move three boxes, never one run.
  //
  // Now every card is a MEMBER of one stack, ordered by `cardOrder` — the ★ run in
  // saved order, then the everyday-first ranked remainder (#1659). Promotion
  // visibility is native: a promoted card is simply first. `orderCardSections` and
  // `growthCardLeads` retired with the boxes; the growth card is an ordinary member
  // whose lead is the life-stage boost's job, and the 1D intraday swap is an
  // ordinary member at `hr-day`.
  //
  // The page's FIXED anatomy is untouched: the Today strip stays at the head (it
  // keeps #1486's vitals-first narrative; the stack stops inheriting it) and the
  // source comparison + history table stay at the foot — skeleton, not cards.
  //
  // The check-in's THREE ratings share ONE card builder (#1408). They are the same
  // kind of reading asked three ways — a 1–5 self-rating from the same daily card,
  // on the same scale, with the same never-range-checked contract — so any drift
  // between their scaffolds, footers or colors would be an accident rather than a
  // decision. Colors come from the registry the tile and the detail page also read.
  const checkInCard = (slug: CheckInMetricSlug, data: Point[]) => (
    <ChartCard
      anchorId={slug}
      testid={`${slug}-trend`}
      title={TREND_METRIC_META[slug].title}
      description="1–5 daily check-ins · selected date range"
      detailHref={metricDetailHref(slug)}
      footer={
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          A subjective self-rating from your daily check-ins — informational
          only, never range-checked.
        </p>
      }
    >
      <LineChartCard
        data={data}
        label={TREND_METRIC_META[slug].title}
        color={TREND_METRIC_META[slug].color}
        gapFill={bodyGapFill(slug)}
      />
    </ChartCard>
  );

  // Every member, before ordering. Membership is unchanged — each entry is still
  // present-gated exactly where it was — and every chart carries its own anchor now
  // that no section box provides one.
  type StackMember = TrendStackItem & { label: string; empty?: boolean };
  const stackMembers: StackMember[] = [
    // At 1D the vitals charts swap for the intraday block, which takes `hr-day`'s
    // rank: one placement rule for every block, so a one-day window re-shapes the
    // stack without re-ordering it by hand.
    ...(intraday
      ? hasIntraday
        ? [
            {
              id: "hr-day",
              label: `${TREND_METRIC_META.hr.summaryTitle ?? TREND_METRIC_META.hr.title} Today`,
              node: intradayBlock,
              wide: true,
            },
          ]
        : []
      : vitalsCharts.map((chart) => ({
          id: chart.key,
          label: chart.title,
          chart: { ...chart, anchorId: chart.anchorId ?? chart.key },
          empty: chart.data.every((point) => point.value == null),
        }))),
    ...(intraday
      ? []
      : compositionCharts.map((chart) => ({
          id: chart.key,
          label: chart.title,
          chart: { ...chart, anchorId: chart.anchorId ?? chart.key },
          empty: chart.data.every((point) => point.value == null),
        }))),
    ...(growthCard
      ? [
          {
            id: "growth",
            label: "Growth percentile",
            node: growthCard,
            wide: true,
          },
        ]
      : []),
    // The check-in trio, each an ordinary ranked member on its own presence.
    ...(hasMood
      ? [
          {
            id: "mood",
            label: TREND_METRIC_META.mood.title,
            node: checkInCard("mood", moodChart),
          },
        ]
      : []),
    ...(hasEnergy
      ? [
          {
            id: "energy",
            label: TREND_METRIC_META.energy.title,
            node: checkInCard("energy", energyChart),
          },
        ]
      : []),
    ...(hasCalm
      ? [
          {
            id: "calm",
            label: TREND_METRIC_META.calm.title,
            node: checkInCard("calm", calmChart),
          },
        ]
      : []),
    ...(intraday
      ? []
      : syncedEntries
          .filter((e) => e.present)
          .map((e) => ({
            id: e.id,
            label: e.label,
            node: e.node,
            // The intraday zoom is the one synced card that has always spanned both
            // columns; it keeps that whatever rank it lands at.
            wide: e.id === "hr-day",
          }))),
  ];

  // The order the stack renders in, with in-window-empty charts sinking to the end
  // (the same layout floor the composition run used to apply, now applied once).
  const bodyStack: StackMember[] = stableEmptyLast(
    applyCardOrder(stackMembers, cardOrder, (m) => m.id),
    (m) => m.empty === true
  );

  // Menu items in PAGE READING ORDER, built FROM the ordered stack — so the menu
  // can never advertise an order the stack below doesn't have.
  const jumpChips: ChartChip[] = bodyStack.map((m) => ({
    id: m.id,
    label: m.label,
  }));

  // ── Tiles ───────────────────────────────────────────────────────────────────
  // Each tile windows the SAME display-unit series its classic chart draws above
  // to the shared Trends range (one gather feeds both). VITALS joined this grid in
  // #1486, so
  // `view=tiles` and `view=all` are two renderings of one metric set — not two
  // different sets. Body fat is dropped for a growth-tracked profile (matching the
  // charts/history); every other metric self-gates on presence.
  const tileSeries: Array<[TrendMetricSlug, Point[]]> = [
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
    ["steps", stepsAll],
    ["active-calories", activeCaloriesAll],
    ["hr", hrAll],
    ["bmi", bmiAll],
    ["lean-mass", leanMassAll],
    ["bone-mass", boneMassAll],
    ["bmr", bmrAll],
    ["hydration", hydrationAll],
    ["calories", caloriesAll],
    ["mood", moodAll],
    ["energy", energyAll],
    ["calm", calmAll],
  ];
  const metricTiles: TrendMetricTile[] = tileSeries
    .filter(([slug]) => slug !== "body-fat" || bodyFatShown)
    // Calm follows the check-in card's own gate in BOTH view modes (#1313/#1408) —
    // `view=tiles` and `view=all` are two renderings of one metric set, so a tile
    // may not surface a scale the chart above is gating away.
    .filter(([slug]) => slug !== "calm" || hasCalm)
    .map(([slug, arr]) =>
      buildTrendMetricTile(TREND_METRIC_META[slug], arr, wu, range)
    )
    .filter((t) => t.present);

  const growthGridTiles =
    growthPresentation?.views.map((growthView) => {
      const points = growthView.points.flatMap((point) =>
        point.percentile == null
          ? []
          : [{ date: point.date, value: Math.round(point.percentile) }]
      );
      const latestPercentile = points.at(-1)?.value ?? null;
      return {
        slug: `growth-${growthView.metric}`,
        id: "growth" as const,
        label: growthView.percentileTitle,
        present: true,
        empty: points.length === 0,
        node: (
          <TrendMiniCard
            title={growthView.percentileTitle}
            href={growthTrendsHref(growthView.metric, range)}
            data={points}
            unit=" percentile"
            color={chartSeries.brand}
            decimals={0}
            headline={
              latestPercentile == null
                ? undefined
                : ordinalPercentile(latestPercentile)
            }
            showChange={false}
            yDomain={[0, 100]}
            emptyMessage={
              !growthView.referenceAvailable
                ? "Not available for this age"
                : "No data in this range"
            }
            testid={`body-tile-growth-${growthView.metric}`}
          />
        ),
      };
    }) ?? [];

  // Sleep links to its strong-topic page rather than a metric detail route, but its
  // tile uses the same sparkline/value component and visual contract as every
  // neighboring Body metric.
  const sleepGridTile = hasSleep
    ? {
        slug: "sleep",
        id: "sleep" as const,
        label: "Sleep",
        present: true,
        empty: sleepDurationChart.length === 0,
        node: (
          <TrendMiniCard
            title="Sleep"
            href="/sleep"
            data={sleepDurationChart}
            unit=" h"
            color={chartSeries.violet}
            decimals={1}
            gapFill={sleepGapFill}
            singleReadingAsChart
            testid="body-tile-sleep"
          />
        ),
      }
    : null;

  return (
    <div className="space-y-6" data-testid="trends-body">
      {/* 1. TODAY — the day's answer comes first, then the way to add to it. */}
      <VitalsTodayStrip rows={todayVitals} date={todayStr} />

      {/* Body-metric data-hygiene findings (issue #45, domain 5): probable-error
          day-over-day weight jumps — a safety-ish signal, so shown above the toggle
          in both layouts. */}
      <BodyHygieneFindings />

      {/* One desktop control row: chart jump on the left, the view selector
          geometrically centered, and the standard Log action on the right. The
          same client component owns the modal state and mounts the shared form in
          the standard dialog shell. On phones it renders nothing; global quick
          entry is the logging path there. */}
      <LogMeasurementsPanel
        defaultDate={todayStr}
        defaultStatedAt={getManualBodyMetricStatedAt(profile.id, todayStr)}
        weightUnit={wu}
        temperatureUnit={units.temperatureUnit}
        showBodyFat={bodyFatShown}
        showGrowth={showGrowthQuickAdd(ageYears)}
        showHeadCirc={showHeadCircEntry(ageMonths)}
        centerControl={
          <BodyViewToggle view={view} tilesHref={tilesHref} allHref={allHref} />
        }
        leftControl={
          <div className={stackContainerClass(view)}>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                Jump to
              </span>
              <ChartJumpMenu items={jumpChips} />
            </div>
          </div>
        }
      />

      {/* Tailwind 4's `space-y-6` puts its 24px margin on the PREVIOUS sibling,
          so a positive margin on these children can no longer replace it. The
          -16px offset preserves the intentionally compact 8px content seam. */}
      {/* #2152: Overview is spark tiles only on phones at EVERY range. Even 1D's
          clock-axis chart stays in the desktop stack; opening a tile remains the
          one-tap route to a full chart on a phone. `?view=all` never overrides the
          viewport rule. */}
      {intraday && (
        <div
          className={`${stackContainerClass(view)} -mt-4`}
          data-testid="body-intraday-view"
        >
          {bodyStack.length > 0 ? (
            <TrendMetricCharts
              items={bodyStack}
              annotations={annotations}
              windows={protocolWindows}
              gapWindow={dayFillWindow(range)}
            />
          ) : (
            <EmptyState message="Nothing intraday recorded today yet. Timed readings and worn heart-rate data show up here; pick a longer window for the daily trends." />
          )}
        </div>
      )}

      {/* The same census component renders both presentations. CSS selects the
          viewport-safe one; there is no forked mobile census. */}
      <div
        className={`${tilesContainerClass(view)} -mt-4`}
        data-testid="body-tiles-view"
      >
        <TrendMetricTiles
          tiles={metricTiles}
          growth={growthGridTiles}
          sleep={sleepGridTile}
          order={cardOrder}
        />

        {/* How the arrangement works, said once (#1643) — under the census
                rather than above it, so it explains what the reader just scanned
                without pushing the census down. The ★ is the ONLY thing that
                reorders this census, and the sequence of what you pin is the
                starred grid's saved order — one scroll up the same page since
                #1644 — so the hint names BOTH halves and where each gesture lives
                instead of adding a second reorder affordance here. */}
        <p
          className="mt-3 text-xs text-slate-500 dark:text-slate-400"
          data-testid="body-pin-hint"
        >
          Star a metric on its own page — open any card — to pin it to the top
          of this section. Pinned cards follow your{" "}
          <Link
            href="/trends#starred"
            className="font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            starred grid
          </Link>{" "}
          order; drag them there to re-sequence them.
        </p>
      </div>

      {!intraday && (
        <>
          {/* The classic full-chart stack — desktop only. Carries the per-chart
              `#id` anchors used by the chart dropdown (#1067 Phase 1). */}
          <div
            className={`${stackContainerClass(view)} -mt-4 space-y-6`}
            data-testid="body-charts-all"
          >
            {/* ONE flat ranked stack (#1674): the ★ run first in saved order, then
                the everyday-first ranked remainder. No titled boxes, so nothing can
                ride above its rank inside one — the growth card, the mood chart and
                the synced daily charts are ordinary members placed by the same
                order, and the annotation toggle bar above drives all of them. */}
            {bodyStack.length > 0 ? (
              <TrendMetricCharts
                items={bodyStack}
                annotations={annotations}
                windows={protocolWindows}
                gapWindow={dayFillWindow(range)}
              />
            ) : (
              <EmptyState message="No body metrics yet. Add a reading with “+ Log” above to see the trend." />
            )}

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
                              {w.body_fat_pct != null
                                ? `${w.body_fat_pct}%`
                                : "—"}
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
        </>
      )}
    </div>
  );
}
