// Cycling's declared extras on the canonical activity detail page.
import Link from "next/link";
import { notFound } from "next/navigation";
import CardFootnote from "@/components/CardFootnote";
import CardGroup, { CardGroupSection } from "@/components/CardGroup";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import { StatBox } from "@/components/StatBox";
import ActivityMetricsLine from "@/components/activity/ActivityMetricsLine";
import ActivitySummaryLine from "@/components/activity/ActivitySummaryLine";
import { activityTiming } from "@/lib/activity-timing";
import {
  importedActivityStats,
  type ImportedActivityStat,
} from "@/lib/activity-import-details";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import {
  cyclingRideHref,
  equipmentHref,
  trainingActivityPageHref,
  type CyclingLens,
} from "@/lib/hrefs";
import { CARDIO_METRICS, RANGES } from "@/lib/analyze-view";
import { SPLIT_INTERVALS_M } from "@/lib/cycling-analytics";
import { isCyclingActivityName } from "@/lib/cycling-activity";
import {
  bestRankMarker,
  comparedWindowText,
  type BestRank,
} from "@/lib/cycling-bests";
import { getRideDetailData } from "@/lib/queries";
import type { ActivityDetailData } from "@/lib/training-activity-detail";
import { heartRateTextStatesMax } from "@/lib/training-log-card";
import {
  sessionHeartRateSeries,
  cyclingHighlights,
  sessionZoneRows,
  type SessionComparisonMetric,
  type SessionComparisonMetricKey,
  wattsPerKg,
} from "@/lib/session-detail";
import type { DistanceUnit, UnitPrefs } from "@/lib/settings";
import { ZONE_COLORS } from "@/lib/training-zones";
import { fmtDistance, fmtKmh, kmTo } from "@/lib/units";
import { SessionChartLinkProvider } from "./SessionChartLink";
import SessionHeartRateChart from "./SessionHeartRateChart";
import SessionComparisonChart from "@/components/SessionComparisonChart";
import { sessionComparisonChartMetrics } from "@/lib/session-comparison-view";
import {
  comparisonDifference,
  comparisonTone,
  formatComparisonValue,
} from "@/lib/session-comparison-format";
import SessionTelemetryChart from "./SessionTelemetryChart";
import SessionRouteMap from "./SessionRouteMap";
import SessionCourseTables from "./SessionCourseTables";
import SessionHighlights from "@/components/SessionHighlights";
import SessionComparisonCard from "@/components/SessionComparisonCard";
import {
  ActivityDetailSectionHeading,
  ActivityDetailSectionNav,
} from "./ActivityDetailSection";

export const dynamic = "force-dynamic";

function statTestId(stat: ImportedActivityStat): string {
  return `ride-stat-${stat.key.replace("_", "-")}`;
}

function RideSummaryComparisonDelta({
  metric,
  distanceUnit,
  prefix,
}: {
  metric: SessionComparisonMetric;
  distanceUnit: DistanceUnit;
  prefix?: string;
}) {
  const difference = comparisonDifference(metric, distanceUnit);
  const medianValue = formatComparisonValue(
    metric.key,
    metric.median,
    distanceUnit
  );
  const tone = {
    neutral: "text-slate-600 dark:text-slate-300",
    good: "text-emerald-700 dark:text-emerald-300",
    watch: "text-amber-700 dark:text-amber-300",
  }[comparisonTone(metric, difference.relation)];

  return (
    <span
      className={`block font-medium ${tone}`}
      data-testid={`ride-summary-comparison-${metric.key.replace("_", "-")}`}
    >
      {prefix ? `${prefix}: ` : null}
      {difference.value ? `${difference.value} ` : null}
      {difference.relation} {medianValue} median
    </span>
  );
}

const SUMMARY_COMPARISON_METRICS: Partial<
  Record<
    ImportedActivityStat["key"],
    { key: SessionComparisonMetricKey; prefix?: string }[]
  >
> = {
  speed: [{ key: "speed" }],
  heart_rate: [{ key: "heart_rate" }],
  power: [{ key: "power" }, { key: "weighted_power", prefix: "Weighted" }],
  cadence: [{ key: "cadence" }],
  elevation: [{ key: "elevation" }],
  relative_effort: [{ key: "relative_effort" }],
};

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function cyclingLens(
  searchParams: Record<string, string | string[] | undefined> | undefined
): CyclingLens | null {
  const one = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const rawMetric = one(searchParams?.metric);
  const rawRange = one(searchParams?.range);
  const rawActivity = one(searchParams?.item)?.trim();
  if (!rawMetric && !rawRange) return null;
  const metric = CARDIO_METRICS.find((item) => item.id === rawMetric)?.id;
  const range = RANGES.find((item) => item.id === rawRange)?.id;
  if (!metric && !range) return null;
  return {
    metric: metric ?? "distance",
    range: range ?? "all",
    activity:
      rawActivity && isCyclingActivityName(rawActivity)
        ? rawActivity
        : undefined,
  };
}

// A rank marker. `.badge` is the shared chip treatment; amber is the same tone
// the strength surfaces already use for a personal record, so one visual grammar
// covers both.
function RankChip({ rank }: { rank: BestRank }) {
  return (
    <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
      {bestRankMarker(rank)}
    </span>
  );
}

export default async function CyclingActivityDetail(props: {
  activityId: number;
  profileId: number;
  units: UnitPrefs;
  formatPrefs: DisplayFormatPrefs;
  rideLens: CyclingLens | null;
  base: ActivityDetailData;
  showMuscles: boolean;
  showDetails: boolean;
  subjectProfileId?: number;
}) {
  const { activityId: id, profileId, units, formatPrefs, base } = props;
  const splitDistanceM = SPLIT_INTERVALS_M[units.distanceUnit];
  const data = getRideDetailData(profileId, id, splitDistanceM, {
    row: base.row,
    activity: base.card.activity,
    routePolyline: base.card.routePolyline,
    heartRateMinutes: base.heartRate.minutes,
    heartRateWindow: base.heartRate.window,
    zoneMinutes: base.heartRate.zoneMinutes,
    zoneModel: base.heartRate.zoneModel,
    comparison: base.comparison,
    streams: base.telemetry.streams,
    traces: base.telemetry.traces,
    course: base.course,
  });
  if (!data) notFound();
  const rideLens = props.rideLens;
  const activityNoun = data.indoorOnly ? "session" : "ride";
  const timing = activityTiming({
    durationMin: data.row.duration_min,
    elapsedMin: data.row.elapsed_min,
    startTime: data.row.start_time,
    endTime: data.row.end_time,
  });
  const importedRaw = importedActivityStats(
    data.activity.imported_metrics!,
    units.distanceUnit
  );
  const imported = data.indoorOnly
    ? {
        primary: importedRaw.primary.filter((stat) => stat.key !== "elevation"),
        secondary: importedRaw.secondary.filter(
          (stat) => stat.key !== "temperature"
        ),
      }
    : importedRaw;
  const averageWattsPerKg = wattsPerKg(data.row.avg_power_w, data.bodyweightKg);
  const primaryStats = imported.primary.map((stat) => {
    if (stat.key === "power" && averageWattsPerKg != null) {
      return {
        ...stat,
        detail: [stat.detail, `${averageWattsPerKg} W/kg`]
          .filter(Boolean)
          .join(" · "),
      };
    }
    return stat;
  });
  const detailStats = [...primaryStats, ...imported.secondary].filter(
    (stat) =>
      stat.key !== "speed" &&
      stat.key !== "heart_rate" &&
      stat.key !== "relative_effort" &&
      stat.key !== "active_kcal"
  );
  const comparisonByKey = new Map(
    data.comparison?.metrics.map((metric) => [metric.key, metric]) ?? []
  );
  const summaryStatSub = (
    key: ImportedActivityStat["key"],
    detail?: string
  ) => {
    const comparisons = (SUMMARY_COMPARISON_METRICS[key] ?? []).flatMap(
      ({ key: comparisonKey, prefix }) => {
        const metric = comparisonByKey.get(comparisonKey);
        return metric ? [{ metric, prefix }] : [];
      }
    );
    if (!detail && comparisons.length === 0) return undefined;
    return (
      <>
        {detail ? <span className="block">{detail}</span> : null}
        {comparisons.map(({ metric, prefix }) => (
          <RideSummaryComparisonDelta
            key={metric.key}
            metric={metric}
            distanceUnit={units.distanceUnit}
            prefix={prefix}
          />
        ))}
      </>
    );
  };
  const zoneRows = data.zoneMinutes ? sessionZoneRows(data.zoneMinutes) : [];
  const zoneTotal = zoneRows.reduce((sum, zone) => sum + zone.minutes, 0);
  const highlights = cyclingHighlights({
    zones: zoneRows,
    powerHrDriftPercent: data.dynamics?.powerHrDriftPercent ?? null,
    segments: data.indoorOnly ? [] : data.segmentEfforts,
  });
  const heartRateSeries = sessionHeartRateSeries(
    data.heartRateWindow,
    data.heartRateMinutes
  );
  const comparisonMetrics = sessionComparisonChartMetrics(
    data.comparison,
    units.distanceUnit
  )
    .filter((metric) => !data.indoorOnly || metric.key !== "elevation")
    .map((metric) => ({
      ...metric,
      points: metric.points.map((point) => ({
        ...point,
        href: rideLens ? cyclingRideHref(point.id, rideLens) : point.href,
      })),
    }));
  const telemetryTraces = data.traces.map((trace) => {
    if (trace.key === "velocity_smooth") {
      return {
        ...trace,
        unit: ` ${units.distanceUnit}/h`,
        points: trace.points.map((point) => ({
          ...point,
          value:
            point.value == null ? null : kmTo(point.value, units.distanceUnit),
        })),
      };
    }
    if (trace.key === "altitude" && units.distanceUnit === "mi") {
      return {
        ...trace,
        unit: " ft",
        points: trace.points.map((point) => ({
          ...point,
          value: point.value == null ? null : point.value * 3.28084,
        })),
      };
    }
    return trace;
  });
  // THE MEDALS AND THE WINDOW THEY MEAN (#3195). `data.bests` ranked this ride's
  // rows against the rides BEFORE it, so these markers are what the ride earned on
  // the day and do not rewrite themselves when a later ride beats it. Lookups
  // rather than a per-row scan, because both tables render every row.
  const powerRankBySeconds = new Map(
    data.bests.power.map((entry) => [entry.seconds, entry.rank])
  );
  const splitRankByIndex = new Map(
    data.bests.splits.map((entry) => [entry.index, entry.rank])
  );
  // The honesty line under each table. It is NOT conditional on a marker being
  // earned: "Compared with 3 earlier rides with recorded power" is exactly the
  // sentence a rider needs when nothing placed, and the first ride with power says
  // so instead of printing a wall of firsts (#2385).
  const powerWindowText = comparedWindowText(
    data.bests.comparedPowerRides,
    "power"
  );
  const splitWindowText = comparedWindowText(
    data.bests.comparedSplitRides,
    "splits"
  );
  const hasPowerProfile =
    data.powerCurve.length > 0 ||
    !!data.cyclingLoad ||
    data.powerZones.length > 0;
  const hasEffort =
    telemetryTraces.length > 0 ||
    heartRateSeries.length > 0 ||
    !!data.dynamics ||
    hasPowerProfile;
  const hasCourse =
    !data.indoorOnly &&
    (!!data.routePolyline ||
      data.distanceSplits.length > 0 ||
      data.laps.length > 0 ||
      data.segmentEfforts.length > 0);
  const hasLinkedEffortCharts =
    telemetryTraces.length > 0 && heartRateSeries.length > 0;
  const hasTimedRoute =
    !data.indoorOnly && !!data.routePolyline && data.timedRoute.length > 1;
  const effortHoverHint = hasLinkedEffortCharts
    ? hasTimedRoute
      ? " Hover either chart to inspect the same point in time and its route position."
      : " Hover either chart to inspect the same point in time."
    : hasTimedRoute
      ? " Hover the chart to follow its route position."
      : "";
  const hasPausedTime =
    timing.activeMin != null &&
    timing.elapsedMin != null &&
    timing.elapsedMin > timing.activeMin;
  const hasPrimarySummary =
    base.card.durationText != null ||
    base.card.distanceText != null ||
    base.card.speedText != null ||
    base.card.heartRateText != null ||
    base.card.activity.imported_metrics?.relative_effort != null ||
    base.card.calorieText != null ||
    base.card.activity.intensity != null;
  // MAX HEART RATE IS STATED ONCE (#3500 item 3). The headline HEART RATE stat
  // is the house avg/max composite — “♥ 148/171 bpm”, the same format the
  // Training Overview strip uses — and this block used to repeat the max as its
  // own box a few rows below it. The composite is only a composite when an
  // average exists, so the box is not deleted: it renders exactly when the
  // headline is NOT already saying the number, which is a ride with a max and no
  // average, or one whose summary line does not render at all.
  //
  // The predicate reads the RENDERED headline string rather than re-deriving the
  // condition from `avg_hr`/`max_hr`, so it cannot drift from what the page
  // actually shows if `activityHeartRateText` changes shape.
  //
  // Max SPEED's box stays: the headline speed is the AVERAGE, so a top speed is
  // new information there — this is a duplication fix, not a density one.
  const headlineStatesMaxHr =
    hasPrimarySummary && heartRateTextStatesMax(base.card.heartRateText);
  const showSecondaryMaxHr =
    data.activity.imported_metrics?.max_hr != null && !headlineStatesMaxHr;
  const hasRecordedMeasurements =
    hasPausedTime ||
    detailStats.length > 0 ||
    showSecondaryMaxHr ||
    data.activity.imported_metrics?.max_speed_kmh != null;
  const hasRideDetails =
    hasPrimarySummary ||
    base.card.contextMetrics.length > 0 ||
    data.equipment != null ||
    hasRecordedMeasurements ||
    highlights.length > 0;
  const sectionLinks = [
    ...(hasEffort ? [{ id: "effort", label: "Effort" }] : []),
    ...(hasCourse ? [{ id: "course", label: "Course" }] : []),
    ...(props.showMuscles ? [{ id: "muscles", label: "Muscles" }] : []),
    ...(props.showDetails ? [{ id: "details", label: "Details" }] : []),
  ];
  return (
    <>
      <SessionChartLinkProvider>
        <ActivityDetailSectionNav sections={sectionLinks} />
        <section
          id="overview"
          className="scroll-mt-[calc(var(--shell-chrome-h)+1rem)] sm:scroll-mt-4"
          data-testid="activity-section-overview"
        >
          {hasRideDetails ? (
            <CardGroup
              title={`${activityNoun === "ride" ? "Ride" : "Session"} details`}
              data-testid="ride-summary"
            >
              {hasPrimarySummary ? (
                <div className="mt-4">
                  <ActivitySummaryLine
                    timeText={null}
                    durationText={base.card.durationText}
                    distanceText={base.card.distanceText}
                    speedText={base.card.speedText}
                    heartRateText={base.card.heartRateText}
                    relativeEffort={
                      base.card.activity.imported_metrics?.relative_effort
                    }
                    relativeEffortProvider={base.card.provenance.label}
                    calorieText={base.card.calorieText}
                    intensity={base.card.activity.intensity}
                    heartRateZone={base.card.activity.heart_rate_zone}
                    density="detail"
                    testId="ride-summary-line"
                    metricDetails={{
                      speed: summaryStatSub("speed"),
                      heartRate: summaryStatSub("heart_rate"),
                      relativeEffort: summaryStatSub("relative_effort"),
                    }}
                  />
                </div>
              ) : null}
              <ActivityMetricsLine
                metrics={base.card.contextMetrics}
                gear={
                  data.equipment
                    ? {
                        label: data.equipment.name,
                        href:
                          props.subjectProfileId == null
                            ? equipmentHref(data.equipment.id)
                            : undefined,
                      }
                    : null
                }
                className="mt-3"
              />
              {hasRecordedMeasurements ? (
                // TWO COLUMNS AT PHONE WIDTH (#3500 item 4). This block used
                // to be `sm:grid-cols-2`, so below 640px every stat was a
                // full-width row with an empty right half — half the phone
                // spent on whitespace, directly under a summary grid that
                // already renders two columns there. It now carries the same
                // column count as that grid at every width; `sm:` and up are
                // unchanged, because two was already the count above the
                // breakpoint.
                <dl
                  className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4 border-b border-black/5 pb-4 dark:border-white/10"
                  data-testid="ride-recorded-measurements"
                >
                  {hasPausedTime ? (
                    <StatBox
                      label="Elapsed time"
                      value={`${timing.elapsedMin} min`}
                      sub={`${timing.restMin ?? 0} min paused`}
                      variant="plain"
                      data-testid="ride-stat-active-time"
                    />
                  ) : null}
                  {data.activity.imported_metrics?.max_speed_kmh != null ? (
                    <StatBox
                      label="Top speed"
                      value={fmtKmh(
                        data.activity.imported_metrics.max_speed_kmh,
                        units.distanceUnit
                      )}
                      variant="plain"
                      data-testid="ride-stat-max-speed"
                    />
                  ) : null}
                  {showSecondaryMaxHr ? (
                    <StatBox
                      label="Max heart rate"
                      value={`${data.activity.imported_metrics?.max_hr} bpm`}
                      variant="plain"
                      data-testid="ride-stat-max-heart-rate"
                    />
                  ) : null}
                  {detailStats.map((stat) => (
                    <StatBox
                      key={stat.key}
                      label={stat.label}
                      value={stat.value}
                      sub={summaryStatSub(stat.key, stat.detail)}
                      variant="plain"
                      // THE ONE BOX THAT SPANS BOTH COLUMNS, AND ONLY ON THE
                      // PHONE (#3500 item 4). Power is the only secondary stat
                      // carrying more than one sub-line — a detail line plus two
                      // comparison sentences — and a half-width column sets each
                      // of them across 146px at 390. It keeps the full row there.
                      // `sm:col-span-1` puts it back in one column from the
                      // breakpoint up, because that is what desktop already did
                      // and #3500 changes nothing above `sm`: measured
                      // 2026-08-23, an unscoped `col-span-2` widened this box
                      // from 347px to 726px at 1280 and reflowed the four boxes
                      // under it.
                      className={
                        stat.key === "power"
                          ? "col-span-2 sm:col-span-1"
                          : undefined
                      }
                      data-testid={statTestId(stat)}
                    />
                  ))}
                </dl>
              ) : null}
              <SessionHighlights
                highlights={highlights}
                title={`${activityNoun === "ride" ? "Ride" : "Session"} highlights`}
              />
            </CardGroup>
          ) : null}
          {data.comparison ? (
            <SessionComparisonCard
              comparison={data.comparison}
              testId="ride-comparison"
              noun={`${activityNoun}s`}
              singularNoun={activityNoun}
            >
              <SessionComparisonChart
                metrics={comparisonMetrics}
                initialMetric={
                  comparisonMetrics.find(
                    (metric) => metric.key === rideLens?.metric
                  )?.key
                }
                noun={`${activityNoun}s`}
                singularNoun={activityNoun}
                testIdPrefix="ride-comparison"
              />
            </SessionComparisonCard>
          ) : null}
        </section>

        {hasEffort ? (
          <section
            id="effort"
            className="scroll-mt-[calc(var(--shell-chrome-h)+1rem)] sm:scroll-mt-4 [&>div+section]:mt-0"
            data-testid="activity-section-effort"
          >
            <ActivityDetailSectionHeading>Effort</ActivityDetailSectionHeading>

            {telemetryTraces.length > 0 ? (
              <CardGroup
                title="Recorded metrics"
                tooltip={`Shows sensor data recorded across the ${activityNoun}. Choose a metric to see how it changed over time.${effortHoverHint}`}
                className="mt-4"
                data-testid="ride-traces"
              >
                <SessionTelemetryChart
                  traces={telemetryTraces}
                  initialMetric={rideLens?.metric}
                />
              </CardGroup>
            ) : null}

            {heartRateSeries.length > 0 ? (
              <CardGroup
                title="Heart rate"
                tooltip={`Shows one-minute heart-rate readings from this ${activityNoun}. Gaps mean no reading was recorded.${effortHoverHint}`}
                className="mt-4"
                data-testid="session-heart-rate"
                action={
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {data.heartRateMinutes.length} recorded min
                  </span>
                }
              >
                <div className="mt-4" data-testid="session-heart-rate-chart">
                  <SessionHeartRateChart
                    data={heartRateSeries}
                    activityDate={data.row.date}
                    zoneModel={data.zoneModel}
                  />
                </div>
                {zoneTotal > 0 ? (
                  <CardGroupSection>
                    <div data-testid="session-heart-rate-zones">
                      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        Time in zones
                      </h3>
                      <div
                        className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800"
                        aria-hidden
                      >
                        {zoneRows.map((zone, index) =>
                          zone.minutes > 0 ? (
                            <span
                              key={zone.id}
                              style={{
                                width: `${(zone.minutes / zoneTotal) * 100}%`,
                                backgroundColor: ZONE_COLORS[index],
                              }}
                            />
                          ) : null
                        )}
                      </div>
                      <ul className="mt-3 space-y-2">
                        {zoneRows.map((zone, index) => (
                          <li
                            key={zone.id}
                            data-testid={`ride-zone-${zone.id}`}
                            className="flex items-center justify-between gap-4 text-sm"
                          >
                            <span className="inline-flex min-w-0 items-center gap-2">
                              <span
                                aria-hidden
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: ZONE_COLORS[index] }}
                              />
                              <span className="font-medium text-slate-700 dark:text-slate-200">
                                {zone.name}
                              </span>
                              <span className="truncate text-slate-500 dark:text-slate-400">
                                {zone.label}
                              </span>
                            </span>
                            <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                              {zone.minutes} min · {zone.percent}%
                            </span>
                          </li>
                        ))}
                      </ul>
                      {data.zoneModel ? (
                        <CardFootnote>{data.zoneModel.formula}</CardFootnote>
                      ) : null}
                    </div>
                  </CardGroupSection>
                ) : null}
              </CardGroup>
            ) : null}

            {data.dynamics ? (
              <CardGroup
                title="Ride analysis"
                tooltip="Shows movement, coasting, climbing, and power-to-heart-rate drift calculated from the ride’s recorded data."
                className="mt-4"
                data-testid="ride-analysis"
              >
                <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {data.dynamics.stoppedSeconds != null ? (
                    <StatBox
                      label="Stopped"
                      value={formatElapsed(data.dynamics.stoppedSeconds)}
                      sub={
                        data.dynamics.movingSeconds != null
                          ? `${formatElapsed(data.dynamics.movingSeconds)} moving`
                          : null
                      }
                      data-testid="ride-analysis-stopped"
                    />
                  ) : null}
                  {data.dynamics.coastingSeconds != null ? (
                    <StatBox
                      label="Coasting"
                      value={formatElapsed(data.dynamics.coastingSeconds)}
                      sub={
                        data.dynamics.coastingPercent != null
                          ? `${data.dynamics.coastingPercent}% of moving time`
                          : null
                      }
                      data-testid="ride-analysis-coasting"
                    />
                  ) : null}
                  {data.dynamics.climbingSeconds != null ? (
                    <StatBox
                      label="Climbing"
                      value={formatElapsed(data.dynamics.climbingSeconds)}
                      sub={
                        data.dynamics.climbingPercent != null
                          ? `${data.dynamics.climbingPercent}% at 3%+ grade`
                          : "Time at 3%+ grade"
                      }
                      data-testid="ride-analysis-climbing"
                    />
                  ) : null}
                  {data.dynamics.powerHrDriftPercent != null ? (
                    <StatBox
                      label="Power / HR drift"
                      value={`${data.dynamics.powerHrDriftPercent > 0 ? "+" : ""}${data.dynamics.powerHrDriftPercent}%`}
                      sub="Positive means efficiency fell in the second half"
                      data-testid="ride-analysis-drift"
                    />
                  ) : null}
                </dl>
              </CardGroup>
            ) : null}

            {hasPowerProfile ? (
              <CardGroup
                title="Power profile"
                tooltip="Shows the ride’s best rolling power efforts and training load relative to FTP."
                className="mt-4"
                data-testid="ride-power-profile"
              >
                {data.powerCurve.length > 0 ? (
                  <>
                    <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {data.powerCurve.map((point) => {
                        const rank = powerRankBySeconds.get(point.seconds);
                        const perKg = wattsPerKg(
                          point.watts,
                          data.bodyweightKg
                        );
                        return (
                          <StatBox
                            key={point.seconds}
                            label={`${point.label} best`}
                            value={`${point.watts} W`}
                            sub={perKg == null ? undefined : `${perKg} W/kg`}
                            badge={rank ? <RankChip rank={rank} /> : undefined}
                            data-testid={`ride-power-curve-${point.seconds}`}
                          />
                        );
                      })}
                    </dl>
                    {powerWindowText ? (
                      <CardFootnote data-testid="ride-power-curve-window">
                        {powerWindowText}
                      </CardFootnote>
                    ) : null}
                  </>
                ) : null}
                {data.cyclingLoad ? (
                  <CardGroupSection>
                    <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                      FTP-relative load
                    </h3>
                    <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                      <StatBox
                        label="FTP snapshot"
                        value={`${data.cyclingLoad.ftpW} W`}
                      />
                      <StatBox
                        label="Intensity factor"
                        value={data.cyclingLoad.intensityFactor.toFixed(2)}
                        sub="Weighted power ÷ FTP"
                      />
                      <StatBox
                        label="Training load"
                        value={String(data.cyclingLoad.trainingLoad)}
                        sub="Duration × intensity² × 100"
                      />
                    </dl>
                  </CardGroupSection>
                ) : null}
                {data.powerZones.length > 0 ? (
                  <CardGroupSection>
                    <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                      Strava power zones
                    </h3>
                    {data.powerZoneTimes.length > 0 ? (
                      <div
                        className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800"
                        aria-label="Time in power zones"
                        data-testid="ride-power-zone-bar"
                      >
                        {data.powerZoneTimes.map((zone, index) =>
                          zone.seconds > 0 ? (
                            <span
                              key={zone.zone}
                              style={{
                                width: `${zone.percent}%`,
                                backgroundColor:
                                  ZONE_COLORS[index % ZONE_COLORS.length],
                              }}
                            />
                          ) : null
                        )}
                      </div>
                    ) : null}
                    <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {data.powerZones.map((zone, index) => (
                        <li
                          key={`${zone.min}-${zone.max}-${index}`}
                          className="rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-ink-800"
                        >
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            Zone {index + 1}
                          </span>
                          <span className="ml-2 tabular-nums text-slate-500 dark:text-slate-400">
                            {zone.min ?? 0}–
                            {zone.max == null || zone.max < 0 ? "∞" : zone.max}{" "}
                            W
                          </span>
                          {data.powerZoneTimes[index] ? (
                            <span className="mt-1 block tabular-nums text-xs text-slate-500 dark:text-slate-400">
                              {formatElapsed(
                                data.powerZoneTimes[index].seconds
                              )}{" "}
                              · {data.powerZoneTimes[index].percent}%
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </CardGroupSection>
                ) : null}
              </CardGroup>
            ) : null}
          </section>
        ) : null}

        {hasCourse ? (
          <section
            id="course"
            className="scroll-mt-[calc(var(--shell-chrome-h)+1rem)] sm:scroll-mt-4 [&>div+section]:mt-0"
            data-testid="activity-section-course"
          >
            <ActivityDetailSectionHeading>Course</ActivityDetailSectionHeading>

            {data.routePolyline ? (
              <section className="mt-4" data-testid="ride-route">
                <h3 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">
                  Route
                </h3>
                <SessionRouteMap
                  polyline={data.routePolyline}
                  timedRoute={data.timedRoute}
                  title={`${data.row.title} route`}
                  className="h-auto w-full rounded-lg border border-black/10 bg-slate-50 text-brand-600 dark:border-white/10 dark:bg-ink-900 dark:text-brand-400"
                />
                {data.routeHistory ? (
                  <div
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-300"
                    data-testid="ride-route-history"
                  >
                    <span>
                      {data.routeHistory.rideCount} earlier{" "}
                      {data.routeHistory.rideCount === 1 ? "ride" : "rides"} on
                      this route
                    </span>
                    {data.routeHistory.fastest ? (
                      <Link
                        href={
                          rideLens
                            ? cyclingRideHref(
                                data.routeHistory.fastest.id,
                                rideLens,
                                props.subjectProfileId
                              )
                            : trainingActivityPageHref(
                                data.routeHistory.fastest.id,
                                props.subjectProfileId
                              )
                        }
                        className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                      >
                        Fastest:{" "}
                        {fmtKmh(
                          data.routeHistory.fastest.speedKmh,
                          units.distanceUnit
                        )}{" "}
                        on{" "}
                        {formatLongDate(
                          data.routeHistory.fastest.date,
                          formatPrefs
                        )}
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {data.distanceSplits.length > 0 ? (
              <CardGroup
                title={`${units.distanceUnit === "mi" ? "5 mi" : "5 km"} splits`}
                tooltip="Breaks the ride into equal-distance splits using the recorded activity data. The final split may be shorter."
                className="mt-4"
                data-testid="ride-distance-splits"
              >
                <div className="mt-4">
                  <ResponsiveTable className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-black/10 text-left text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                        <th className="th">Split</th>
                        <th className="th text-right">Distance</th>
                        <th className="th text-right">Time</th>
                        <th className="th text-right">Speed</th>
                        <th className="th text-right">Power</th>
                        <th className="th text-right">Heart rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.distanceSplits.map((split) => (
                        <tr
                          key={split.index}
                          className="border-b border-black/5 last:border-0 dark:border-white/5"
                        >
                          <Td slot="title" className="py-2.5 pr-3 font-medium">
                            <span className="flex items-center gap-1.5">
                              {split.index}
                              {splitRankByIndex.has(split.index) ? (
                                <RankChip
                                  rank={splitRankByIndex.get(split.index)!}
                                />
                              ) : null}
                            </span>
                          </Td>
                          <Td
                            slot="value"
                            label="Distance"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {fmtDistance(
                              split.distanceM / 1000,
                              units.distanceUnit
                            )}
                          </Td>
                          <Td
                            slot="meta"
                            label="Time"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {formatElapsed(split.timeSec)}
                          </Td>
                          <Td
                            slot="meta"
                            label="Speed"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {fmtKmh(split.averageSpeedKmh, units.distanceUnit)}
                          </Td>
                          <Td
                            slot="meta"
                            label="Power"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {split.averageWatts == null
                              ? "—"
                              : `${Math.round(split.averageWatts)} W`}
                          </Td>
                          <Td
                            slot="meta"
                            label="Heart rate"
                            className="py-2.5 pl-3 text-right tabular-nums"
                          >
                            {split.averageHeartrate == null
                              ? "—"
                              : `${Math.round(split.averageHeartrate)} bpm`}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </ResponsiveTable>
                </div>
                {splitWindowText ? (
                  <CardFootnote data-testid="ride-splits-window">
                    {splitWindowText}
                  </CardFootnote>
                ) : null}
              </CardGroup>
            ) : null}

            <SessionCourseTables
              laps={data.laps}
              segmentEfforts={data.segmentEfforts}
              distanceUnit={units.distanceUnit}
            />
          </section>
        ) : null}
      </SessionChartLinkProvider>
    </>
  );
}
