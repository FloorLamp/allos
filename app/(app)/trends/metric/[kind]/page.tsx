import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getUnitPrefs,
  getUserAge,
  getUserBirthdate,
  type WeightUnit,
} from "@/lib/settings";
import { round as roundTo } from "@/lib/units";
import { ageInMonthsFromBirthdate, lastNDates } from "@/lib/date";
import {
  showHeadCircEntry,
  showBodyFat,
  showGrowthQuickAdd,
} from "@/lib/growth-metrics";
import {
  getBiomarkerSeries,
  getBodyMetricDailySeries,
  getDaylightOutdoorMinutesSeries,
  getMetricDailyTotals,
  getHrDailySummary,
  getMoodLogs,
  getGoals,
} from "@/lib/queries";
import { HRV_METRIC } from "@/lib/vitals-input";
import { bmiSeriesDatePaired } from "@/lib/growth-series";
import { dispWeight, round } from "@/lib/units";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import {
  buildTrendAnnotations,
  buildProtocolTrendWindows,
} from "@/lib/trends-series";
import { projectGoal, describeEta } from "@/lib/trend-projection";
import { isGoalLive } from "@/lib/goals";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  isAllTimeRange,
  isCustomRange,
  normalizeTimelineRange,
  resolveTrendsRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import { rangeSummaryLabel } from "@/lib/trends";
import {
  BODY_METRIC_META,
  isBodyMetricSlug,
  resolveBodyMetricUnit,
  bodyMetricPeriodStats,
  type BodyMetricSlug,
  type PeriodStat,
} from "@/lib/trends-body-metrics";
import type { AppRoute } from "@/lib/hrefs";
import type { BodyMetricKind, Goal } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import DateRangeControl from "@/components/DateRangeControl";
import BodyTrendCharts, {
  type BodyChartSpec,
} from "@/components/BodyTrendCharts";
import MeasurementsQuickAdd from "../../MeasurementsQuickAdd";

export const dynamic = "force-dynamic";

// The widest span the sun/outdoor series is gathered over — its query answers a list
// of DATES (there is no row store to read back), so the page picks the horizon and
// the range control windows within it. A year matches the Body tab's own cap.
const SUN_SERIES_DAYS = 366;

// A body-metric detail page (#1067 Phase 2) — the per-metric surface reached from a
// Trends → Body sparkline tile, mirroring the biomarker series view (/biomarkers/view)
// that labs have always had but body metrics never did: a big chart with the shared
// range control + med/situation annotations + a goal overlay, trailing 7/30/90-day
// period stats, and (for a manually-enterable metric) that metric's single quick-add.
//
// The series is re-derived through the SAME queries the Body tab's chart stack uses
// (the biomarker-view precedent — a separate surface re-deriving via the shared query
// layer), then windowed here; the metadata (label/unit/color/goal/quick-add) comes
// from the ONE registry (BODY_METRIC_META) so this page and the tile can't disagree.

// One canonical-name vitals series ({date,value}), rounded to the metric's decimals
// — the shape the chart + tile take. Shared by the five vitals slugs (#1486).
function biomarkerPoints(
  canonical: string,
  profileId: number,
  decimals: number
): { date: string; value: number }[] {
  return getBiomarkerSeries(profileId, canonical)
    .filter((r) => r.value_num != null)
    .map((r) => ({
      date: r.date,
      value: roundTo(r.value_num as number, decimals),
    }));
}

// The metric's FULL display-unit series (oldest→newest), read unbounded so an older
// window isn't silently truncated (#399). Weight follows the login's weight unit.
function fullSeriesFor(
  slug: BodyMetricSlug,
  profileId: number,
  weightUnit: WeightUnit,
  todayStr: string
): { date: string; value: number }[] {
  switch (slug) {
    // ── vitals (#1486) ────────────────────────────────────────────────────────
    // Read through the SAME canonical-name series query the merged Body tab's
    // vitals section draws, so a tile, its detail page, and the tab's full chart
    // are three formatters over one read.
    case "systolic":
      return biomarkerPoints("Blood Pressure Systolic", profileId, 0);
    case "diastolic":
      return biomarkerPoints("Blood Pressure Diastolic", profileId, 0);
    case "spo2":
      return biomarkerPoints("Oxygen Saturation", profileId, 0);
    case "respiratory-rate":
      return biomarkerPoints("Respiratory Rate", profileId, 0);
    case "temperature":
      return biomarkerPoints("Body Temperature", profileId, 1);
    case "hrv":
      return getMetricDailyTotals(profileId, HRV_METRIC, ALL_ROWS).map((r) => ({
        date: r.date,
        value: Math.round(r.value),
      }));
    case "weight":
      return getBodyMetricDailySeries(profileId, "weight", ALL_ROWS).map(
        (p) => ({ date: p.date, value: dispWeight(p.value, weightUnit) })
      );
    case "body-fat":
      return getBodyMetricDailySeries(profileId, "body_fat", ALL_ROWS).map(
        (p) => ({ date: p.date, value: round(p.value, 1) })
      );
    case "resting-hr":
      return getBodyMetricDailySeries(profileId, "resting_hr", ALL_ROWS).map(
        (p) => ({ date: p.date, value: Math.round(p.value) })
      );
    case "height":
      return getMetricDailyTotals(profileId, "height_cm", ALL_ROWS).map(
        (r) => ({ date: r.date, value: round(r.value, 1) })
      );
    case "head-circ":
      return getMetricDailyTotals(
        profileId,
        "head_circumference_cm",
        ALL_ROWS
      ).map((r) => ({ date: r.date, value: round(r.value, 1) }));
    case "sun":
      // Sun/outdoor minutes is the one DATE-DRIVEN series here: the query answers a
      // list of days rather than reading rows back, so the page asks for the widest
      // span it charts (a year) and the range control windows it like every other
      // metric. Same getDaylightOutdoorMinutes computation the Body tab's card and
      // the DaylightChip read — a formatter, not a second engine (#221).
      return getDaylightOutdoorMinutesSeries(
        profileId,
        lastNDates(todayStr, SUN_SERIES_DAYS)
      );
    case "steps":
      return getMetricDailyTotals(profileId, "steps", ALL_ROWS).map((r) => ({
        date: r.date,
        value: Math.round(r.value),
      }));
    case "hr":
      // getHrDailySummary caps at limitDays; a wide cap covers the full history.
      return getHrDailySummary(profileId, 3650).map((r) => ({
        date: r.date,
        value: Math.round(r.avg),
      }));
    case "bmi":
      // BMI pairs each weigh-in with the height in effect on/before that date — the
      // SAME date-paired derivation the growth card + Body tab use (#407).
      return bmiSeriesDatePaired(
        getBodyMetricDailySeries(profileId, "weight", ALL_ROWS).map((w) => ({
          date: w.date,
          value: w.value,
        })),
        getMetricDailyTotals(profileId, "height_cm", ALL_ROWS).map((r) => ({
          date: r.date,
          value: r.value,
        }))
      ).map((p) => ({ date: p.date, value: round(p.value, 1) }));
    case "lean-mass":
      return getMetricDailyTotals(profileId, "lean_mass_kg", ALL_ROWS).map(
        (r) => ({ date: r.date, value: round(r.value, 1) })
      );
    case "bone-mass":
      return getMetricDailyTotals(profileId, "bone_mass_kg", ALL_ROWS).map(
        (r) => ({ date: r.date, value: round(r.value, 2) })
      );
    case "bmr":
      return getMetricDailyTotals(profileId, "bmr_kcal", ALL_ROWS).map((r) => ({
        date: r.date,
        value: Math.round(r.value),
      }));
    case "hydration":
      return getMetricDailyTotals(profileId, "hydration_l", ALL_ROWS).map(
        (r) => ({ date: r.date, value: round(r.value, 2) })
      );
    case "calories":
      return getMetricDailyTotals(profileId, "nutrition_kcal", ALL_ROWS).map(
        (r) => ({ date: r.date, value: Math.round(r.value) })
      );
    case "mood":
      return getMoodLogs(profileId).map((m) => ({
        date: m.date,
        value: m.valence,
      }));
  }
}

// The goal overlay (target line + projection caption) for a metric that can carry a
// body-metric goal — the SAME shape the Body tab draws (projectGoal + describeEta).
function goalOverlay(
  profileId: number,
  goalMetric: BodyMetricKind,
  data: { date: string; value: number }[],
  unit: string,
  decimals: number,
  weightUnit: WeightUnit
): Pick<BodyChartSpec, "referenceValue" | "projectionNote"> {
  const goal: Goal | undefined = getGoals(profileId).find(
    (g) =>
      g.body_metric === goalMetric && isGoalLive(g) && g.target_value != null
  );
  if (!goal || goal.target_value == null) {
    return { referenceValue: null, projectionNote: null };
  }
  const toDisplay = (v: number) =>
    goalMetric === "weight" ? dispWeight(v, weightUnit) : round(v, decimals);
  const target = toDisplay(goal.target_value);
  const baseline =
    goal.baseline_value == null ? null : toDisplay(goal.baseline_value);
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
  if (projectionNote && projection?.confidence === "low") {
    projectionNote += " (rough estimate)";
  }
  return {
    referenceValue: {
      value: target,
      label: `Goal ${round(target, decimals)}${unit}`,
    },
    projectionNote,
  };
}

export default async function BodyMetricDetailPage(props: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    // The explicit all-time sentinel (#1485 G) — see resolveTrendsRange.
    range?: string | string[];
  }>;
}) {
  const { kind } = await props.params;
  const searchParams = await props.searchParams;

  if (!isBodyMetricSlug(kind)) {
    return (
      <PageContainer width="reading" className="space-y-4">
        <BackLink />
        <PageHeader title="Metric" />
        <EmptyState message="Unknown metric." />
      </PageContainer>
    );
  }

  const { login, profile } = await requireSession();
  const meta = BODY_METRIC_META[kind];
  const weightUnit = getUnitPrefs(login.id).weightUnit;
  const unit = resolveBodyMetricUnit(meta, weightUnit);
  const todayStr = today(profile.id);

  const from = timelineDateFromParam(searchParams.from);
  const to = timelineDateFromParam(searchParams.to);
  // Same window rule as the hub (#1485 G): 90D by default, an explicit ?from/?to
  // verbatim, `?range=all` for all time. This page is reached BY the hub's tiles,
  // so a different default here would silently rewind the window on every drill-in.
  const range = resolveTrendsRange(
    normalizeTimelineRange(from, to),
    todayStr,
    Array.isArray(searchParams.range)
      ? searchParams.range[0]
      : searchParams.range
  );

  const fullSeries = fullSeriesFor(kind, profile.id, weightUnit, todayStr);
  const windowed = filterSeriesByRange(fullSeries, range);
  const stats = bodyMetricPeriodStats(fullSeries, todayStr, meta.decimals);

  // Goal overlay + event annotations, both windowed to the shared range — the same
  // machinery the Body tab draws (buildTrendAnnotations / buildProtocolTrendWindows).
  const overlay = meta.goalMetric
    ? goalOverlay(
        profile.id,
        meta.goalMetric,
        windowed,
        unit,
        meta.decimals,
        weightUnit
      )
    : { referenceValue: null, projectionNote: null };
  const annotations = buildTrendAnnotations(profile.id, range);
  const protocolWindows = buildProtocolTrendWindows(profile.id, range);

  const chartSpec: BodyChartSpec = {
    key: meta.slug,
    detailHref: null, // detail-none: this page IS the detail — a card here would link to itself
    title: meta.title,
    data: windowed,
    label: meta.label,
    unit,
    color: meta.color,
    referenceValue: overlay.referenceValue,
    projectionNote: overlay.projectionNote,
  };

  const latest =
    fullSeries.length > 0 ? fullSeries[fullSeries.length - 1] : null;

  const base = `/trends/metric/${kind}`;
  const rangeHref = (r: DateRange): AppRoute => {
    const sp = new URLSearchParams();
    if (r.from) sp.set("from", r.from);
    if (r.to) sp.set("to", r.to);
    // The control asks for `{}` for both "All time" and "Clear dates"; with a 90D
    // default that URL is no longer all-time, so it needs the explicit sentinel.
    if (isAllTimeRange(r)) sp.set(ALL_TIME_RANGE_PARAM, ALL_TIME_RANGE_VALUE);
    const qs = sp.toString();
    return (qs ? `${base}?${qs}` : base) as AppRoute;
  };

  // The metric's single quick-add (only for a manually-enterable metric).
  const birthdate = getUserBirthdate(profile.id);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, todayStr)
    : null;
  const age = getUserAge(profile.id);
  const quickAdd =
    meta.quickAdd === "measurements" ? (
      // The ONE combined form (#1486) — the same component the Body tab's desktop
      // expander and the quick-entry overlay mount. Its life-stage gates come from
      // the same lib/growth-metrics predicates everywhere.
      <MeasurementsQuickAdd
        weightUnit={weightUnit}
        defaultDate={todayStr}
        temperatureUnit={getUnitPrefs(login.id).temperatureUnit}
        showBodyFat={showBodyFat(age)}
        showGrowth={showGrowthQuickAdd(age)}
        showHeadCirc={showHeadCircEntry(ageMonths)}
      />
    ) : null;

  return (
    <PageContainer width="reading" className="space-y-6">
      <BackLink />
      <PageHeader
        title={meta.title}
        subtitle={
          latest != null
            ? `Latest ${round(latest.value, meta.decimals)}${unit} · as of ${latest.date}`
            : "No readings yet"
        }
      />

      {/* Shared range control (7D/30D/90D/All-time). */}
      <DateRangeControl
        basePath={base}
        range={range}
        todayStr={todayStr}
        buildHref={rangeHref}
        idPrefix="metric"
        // Summary chip only for a CUSTOM window — with a preset pill lit it just
        // repeats that pill's label (#1455 D).
        rightSlot={
          isCustomRange(range, todayStr) ? (
            <span className="whitespace-nowrap rounded-full border border-black/10 bg-white/60 px-3 py-1 text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400">
              {rangeSummaryLabel(range, todayStr)}
            </span>
          ) : undefined
        }
      />

      {/* Trailing-window period stats (7 / 30 / 90 days) — always relative to today,
          independent of the range control above. */}
      <PeriodStatsCard stats={stats} unit={unit} />

      {/* The big chart — reuses the Body tab's chart card (annotation toggle + goal
          target line + projection note). */}
      <div data-testid="metric-detail-chart">
        {windowed.length === 0 ? (
          <div className="card">
            <EmptyState message="No readings in this range." />
          </div>
        ) : (
          <BodyTrendCharts
            charts={[chartSpec]}
            annotations={annotations}
            windows={protocolWindows}
          />
        )}
      </div>

      {quickAdd}
    </PageContainer>
  );
}

function BackLink() {
  return (
    <Link
      href="/trends?tab=body"
      className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
    >
      <IconArrowLeft className="h-4 w-4" /> Back to Body
    </Link>
  );
}

function PeriodStatsCard({
  stats,
  unit,
}: {
  stats: PeriodStat[];
  unit: string;
}) {
  const fmt = (v: number | null) => (v == null ? "—" : `${v}${unit}`);
  return (
    <div className="card" data-testid="metric-period-stats">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        Period stats
      </h2>
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div
            key={s.label}
            data-testid={`period-stat-${s.days}`}
            className="rounded-lg border border-black/10 p-3 dark:border-white/10"
          >
            <div className="section-label">{s.label}</div>
            {s.count === 0 ? (
              <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                No data
              </div>
            ) : (
              <dl className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400">Latest</dt>
                  <dd className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {fmt(s.latest)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400">Avg</dt>
                  <dd className="tabular-nums">{fmt(s.avg)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400">Range</dt>
                  <dd className="tabular-nums">
                    {s.min}–{s.max}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-slate-400">Change</dt>
                  <dd className="tabular-nums">
                    {s.delta != null && s.delta > 0 ? "+" : ""}
                    {fmt(s.delta)}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
