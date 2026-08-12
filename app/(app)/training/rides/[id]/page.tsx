import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  IconArrowLeft,
  IconBike,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import ActivityProvenance from "@/components/ActivityProvenance";
import CardFootnote from "@/components/CardFootnote";
import CardGroup, { CardGroupSection } from "@/components/CardGroup";
import NotesText from "@/components/NotesText";
import PageContainer from "@/components/PageContainer";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import { StatBox } from "@/components/StatBox";
import { PageHeader } from "@/components/ui";
import { activityTiming } from "@/lib/activity-timing";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  importedActivityStats,
  type ImportedActivityStat,
} from "@/lib/activity-import-details";
import { DOCUMENT_SOURCE_PREFIX } from "@/lib/body-metric-extract";
import { formatActivityCalories } from "@/lib/calorie-estimate";
import { speedKmh } from "@/lib/coaching/cardio";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import { activityTimeText } from "@/lib/training-log-card";
import { activityProvenanceLabel } from "@/lib/training-log-format";
import {
  CYCLING_OVERVIEW_HREF,
  cyclingOverviewHref,
  cyclingRideHref,
  equipmentHref,
  type CyclingLens,
} from "@/lib/hrefs";
import { CARDIO_METRICS, RANGES } from "@/lib/analyze-view";
import { isCyclingActivityName } from "@/lib/cycling-activity";
import { getRideDetailData } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import {
  rideHeartRateSeries,
  rideHighlights,
  rideZoneRows,
  type RideHighlight,
  type RideComparisonMetric,
  type RideComparisonMetricKey,
  type RideHistoryItem,
  wattsPerKg,
} from "@/lib/ride-detail";
import {
  getDisplayFormatPrefs,
  getUnitPrefs,
  type DistanceUnit,
} from "@/lib/settings";
import { ZONE_COLORS, zonePresentation } from "@/lib/training-zones";
import { fmtDistance, fmtKmh, kmTo, round } from "@/lib/units";
import RideDetailActions from "./RideDetailActions";
import { RideChartLinkProvider } from "./RideChartLink";
import RideHeartRateChart from "./RideHeartRateChart";
import RideComparisonChart, {
  type RideComparisonChartMetric,
} from "./RideComparisonChart";
import RideTelemetryChart from "./RideTelemetryChart";
import RideRouteMap from "./RideRouteMap";

export const dynamic = "force-dynamic";

function statTestId(stat: ImportedActivityStat): string {
  return `ride-stat-${stat.key.replace("_", "-")}`;
}

const COMPARISON_LABELS: Record<RideComparisonMetricKey, string> = {
  speed: "Average speed",
  heart_rate: "Average heart rate",
  power: "Average power",
  weighted_power: "Weighted power",
  cadence: "Average cadence",
  elevation: "Elevation gain",
  relative_effort: "Relative effort",
};

const COMPARISON_SHORT_LABELS: Record<RideComparisonMetricKey, string> = {
  speed: "Speed",
  heart_rate: "Heart rate",
  power: "Power",
  weighted_power: "Weighted power",
  cadence: "Cadence",
  elevation: "Elevation",
  relative_effort: "Effort",
};

function comparisonChartUnit(
  key: RideComparisonMetricKey,
  distanceUnit: DistanceUnit
): string {
  if (key === "speed") return ` ${distanceUnit}/h`;
  if (key === "heart_rate") return " bpm";
  if (key === "power" || key === "weighted_power") return " W";
  if (key === "cadence") return " rpm";
  if (key === "elevation") return distanceUnit === "mi" ? " ft" : " m";
  return "";
}

function comparisonChartValue(
  key: RideComparisonMetricKey,
  value: number,
  distanceUnit: DistanceUnit
): number {
  if (key === "speed") return kmTo(value, distanceUnit);
  if (key === "elevation" && distanceUnit === "mi") return value * 3.28084;
  return value;
}

function formatComparisonValue(
  metric: RideComparisonMetric,
  value: number,
  distanceUnit: DistanceUnit
): string {
  if (metric.key === "speed") return fmtKmh(value, distanceUnit);
  if (metric.key === "heart_rate") return `${Math.round(value)} bpm`;
  if (metric.key === "power" || metric.key === "weighted_power") {
    return `${Math.round(value)} W`;
  }
  if (metric.key === "cadence") return `${Math.round(value)} rpm`;
  if (metric.key === "elevation") {
    return distanceUnit === "mi"
      ? `${Math.round(value * 3.28084)} ft`
      : `${Math.round(value)} m`;
  }
  return String(round(value, 1));
}

function comparisonDifferencePresentation(
  metric: RideComparisonMetric,
  distanceUnit: DistanceUnit
): { value: string | null; relation: "above" | "below" | "same as" } {
  const difference =
    metric.key === "speed"
      ? kmTo(metric.difference, distanceUnit)
      : metric.key === "elevation" && distanceUnit === "mi"
        ? metric.difference * 3.28084
        : metric.difference;
  const rounded =
    metric.key === "speed" || metric.key === "relative_effort"
      ? round(difference, 1)
      : Math.round(difference);
  const suffix =
    metric.key === "speed"
      ? ` ${distanceUnit}/h`
      : metric.key === "heart_rate"
        ? " bpm"
        : metric.key === "power" || metric.key === "weighted_power"
          ? " W"
          : metric.key === "cadence"
            ? " rpm"
            : metric.key === "elevation"
              ? distanceUnit === "mi"
                ? " ft"
                : " m"
              : "";
  if (rounded === 0) return { value: null, relation: "same as" };
  return {
    value: `${Math.abs(rounded)}${suffix}`,
    relation: rounded > 0 ? "above" : "below",
  };
}

function RideSummaryComparisonDelta({
  metric,
  distanceUnit,
  prefix,
}: {
  metric: RideComparisonMetric;
  distanceUnit: DistanceUnit;
  prefix?: string;
}) {
  const difference = comparisonDifferencePresentation(metric, distanceUnit);
  const medianValue = formatComparisonValue(
    metric,
    metric.median,
    distanceUnit
  );
  // Only speed has a clear performance direction among these like-for-like
  // ride deltas. More HR, power, elevation, cadence, or effort is context, not
  // automatically “better”, so those comparisons keep a neutral blue tone.
  const tone =
    metric.key !== "speed"
      ? "text-sky-700 dark:text-sky-300"
      : difference.relation === "above"
        ? "text-emerald-700 dark:text-emerald-300"
        : difference.relation === "below"
          ? "text-amber-700 dark:text-amber-300"
          : "text-slate-600 dark:text-slate-300";

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

function RideHighlights({
  highlights,
  noun = "ride",
}: {
  highlights: RideHighlight[];
  noun?: "ride" | "session";
}) {
  if (highlights.length === 0) return null;
  const presentation = (highlight: RideHighlight) => {
    if (highlight.key === "heart_rate_zone") {
      return {
        label: "Most time in HR zone",
        value: highlight.zone.name,
        detail: `${highlight.zone.minutes} min · ${highlight.zone.percent}% of recorded HR`,
        tone: "border-slate-300 bg-slate-50/60 dark:border-slate-600 dark:bg-ink-800",
        color: ZONE_COLORS[highlight.zone.id - 1],
      };
    }
    if (highlight.key === "segment_results") {
      const value =
        highlight.personalBestCount > 0
          ? `${highlight.personalBestCount} personal ${
              highlight.personalBestCount === 1 ? "best" : "bests"
            }`
          : `${highlight.leaderboardCount} leaderboard ${
              highlight.leaderboardCount === 1 ? "result" : "results"
            }`;
      const detail =
        highlight.personalBestCount > 0 && highlight.leaderboardCount > 0
          ? `${highlight.leaderboardCount} top-10 leaderboard ${
              highlight.leaderboardCount === 1 ? "result" : "results"
            }`
          : "From recorded Strava segments";
      return {
        label: "Best efforts",
        value,
        detail,
        tone: "border-emerald-500 bg-emerald-50/60 dark:border-emerald-400 dark:bg-emerald-950/20",
        color: undefined,
      };
    }
    const stable = Math.abs(highlight.driftPercent) < 2;
    const improved = highlight.driftPercent < 0;
    return {
      label: "Efficiency",
      value: `${highlight.driftPercent > 0 ? "+" : ""}${highlight.driftPercent}% drift`,
      detail: stable
        ? "Held steady across both halves"
        : improved
          ? "Improved in the second half"
          : "Fell in the second half",
      tone: stable
        ? "border-slate-300 bg-slate-50/60 dark:border-slate-600 dark:bg-ink-800"
        : improved
          ? "border-emerald-500 bg-emerald-50/60 dark:border-emerald-400 dark:bg-emerald-950/20"
          : "border-amber-500 bg-amber-50/60 dark:border-amber-400 dark:bg-amber-950/20",
      color: undefined,
    };
  };

  return (
    <div className="mt-5" data-testid="ride-highlights">
      <h3 className="section-label">
        {noun === "ride" ? "Ride" : "Session"} highlights
      </h3>
      <ul className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
        {highlights.map((highlight) => {
          const item = presentation(highlight);
          return (
            <li
              key={highlight.key}
              className={`min-w-0 rounded-lg border-l-2 px-3 py-2.5 ${item.tone}`}
              data-testid={`ride-highlight-${highlight.key.replaceAll("_", "-")}`}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                {item.color ? (
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                ) : null}
                {item.label}
              </span>
              <span className="mt-0.5 block text-sm font-semibold text-slate-800 dark:text-slate-100">
                {item.value}
              </span>
              <span className="mt-0.5 block text-xs leading-4 text-slate-500 dark:text-slate-400">
                {item.detail}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const SUMMARY_COMPARISON_METRICS: Partial<
  Record<
    ImportedActivityStat["key"],
    { key: RideComparisonMetricKey; prefix?: string }[]
  >
> = {
  speed: [{ key: "speed" }],
  heart_rate: [{ key: "heart_rate" }],
  power: [{ key: "power" }, { key: "weighted_power", prefix: "Weighted" }],
  cadence: [{ key: "cadence" }],
  elevation: [{ key: "elevation" }],
  relative_effort: [{ key: "relative_effort" }],
};

function RideHeaderNavigation({
  previous,
  next,
  formatPrefs,
  distanceUnit,
  lens,
  noun,
}: {
  previous: RideHistoryItem | null;
  next: RideHistoryItem | null;
  formatPrefs: DisplayFormatPrefs;
  distanceUnit: DistanceUnit;
  lens: CyclingLens | null;
  noun: "ride" | "session";
}) {
  if (!previous && !next) return null;

  const rideMeta = (ride: RideHistoryItem) =>
    [
      formatLongDate(ride.date, formatPrefs, { year: "always" }),
      ride.duration_min != null ? `${Math.round(ride.duration_min)} min` : null,
      ride.distance_km != null
        ? fmtDistance(ride.distance_km, distanceUnit)
        : null,
    ].filter((value): value is string => value != null);
  const linkTitle = (direction: "Previous" | "Next", ride: RideHistoryItem) =>
    `${direction} ${noun}: ${ride.title}. ${rideMeta(ride).join(" · ")}`;
  const meta = (
    ride: RideHistoryItem,
    testId: string,
    align: "start" | "end" = "start"
  ) => {
    return (
      <span
        className={`mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 ${
          align === "end" ? "justify-end" : ""
        }`}
        data-testid={testId}
      >
        {rideMeta(ride).map((detail) => (
          <span key={detail} className="min-w-0 whitespace-normal">
            {detail}
          </span>
        ))}
      </span>
    );
  };

  return (
    <nav
      className="mb-4 grid grid-cols-2 md:mb-6"
      aria-label={`Adjacent ${noun === "ride" ? "rides" : "sessions"}`}
      data-testid="ride-header-navigation"
    >
      {previous ? (
        <Link
          href={
            lens
              ? cyclingRideHref(previous.id, lens)
              : `/training/rides/${previous.id}`
          }
          className="group min-w-0 border-r border-black/5 pr-3 text-left transition hover:text-brand-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-white/5 dark:hover:text-brand-300"
          aria-label={linkTitle("Previous", previous)}
          title={linkTitle("Previous", previous)}
          data-testid="ride-previous-link"
        >
          <span className="min-w-0">
            <span className="section-label flex items-center gap-1">
              <IconChevronLeft
                className="h-3.5 w-3.5 shrink-0 text-slate-400 transition group-hover:-translate-x-0.5 group-hover:text-brand-600 dark:group-hover:text-brand-400"
                aria-hidden="true"
              />
              Previous {noun}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-sm font-semibold text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-300">
              {previous.title}
            </span>
            {meta(previous, "ride-previous-meta")}
          </span>
        </Link>
      ) : null}
      {next ? (
        <Link
          href={
            lens ? cyclingRideHref(next.id, lens) : `/training/rides/${next.id}`
          }
          className="group min-w-0 pl-3 text-right transition hover:text-brand-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-brand-300"
          aria-label={linkTitle("Next", next)}
          title={linkTitle("Next", next)}
          data-testid="ride-next-link"
        >
          <span className="min-w-0">
            <span className="section-label flex items-center justify-end gap-1">
              Next {noun}
              <IconChevronRight
                className="h-3.5 w-3.5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-brand-600 dark:group-hover:text-brand-400"
                aria-hidden="true"
              />
            </span>
            <span className="mt-0.5 line-clamp-2 block text-sm font-semibold text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-300">
              {next.title}
            </span>
            {meta(next, "ride-next-meta", "end")}
          </span>
        </Link>
      ) : null}
    </nav>
  );
}

function RideSectionNavigation({
  sections,
}: {
  sections: { id: string; label: string }[];
}) {
  return (
    <nav
      aria-label="Ride sections"
      className="mb-5 flex rounded-lg bg-slate-100 p-1 dark:bg-ink-800"
      data-testid="ride-section-navigation"
    >
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-xs font-semibold text-slate-600 transition hover:bg-white hover:text-brand-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-300 dark:hover:bg-ink-700 dark:hover:text-brand-300 sm:text-sm"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

function RideSectionHeading({
  children,
  first = false,
}: {
  children: string;
  first?: boolean;
}) {
  return (
    <div className={`mb-3 flex items-center gap-3 ${first ? "" : "mt-7"}`}>
      <h2 className="section-label shrink-0">{children}</h2>
      <span
        aria-hidden="true"
        className="h-px flex-1 bg-black/5 dark:bg-white/10"
      />
    </div>
  );
}

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

function cyclingLens(
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

export default async function RideDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: rawId } = await props.params;
  const lens = cyclingLens(await props.searchParams);
  const session = await requireSession();
  if (isTrainingRestricted(session.profile.id)) redirect("/");
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const units = getUnitPrefs(session.login.id);
  const formatPrefs = getDisplayFormatPrefs(session.login.id);
  const splitDistanceM = units.distanceUnit === "mi" ? 5 * 1609.344 : 5 * 1000;
  const data = getRideDetailData(session.profile.id, id, splitDistanceM);
  if (!data) notFound();
  const rideLens = lens
    ? { ...lens, activity: lens.activity ?? data.activityName }
    : null;
  const activityNoun = data.indoorOnly ? "session" : "ride";
  const activityPlural = data.indoorOnly ? "sessions" : "rides";
  const previousRide = data.rideHistory.before[0] ?? null;
  const nextRide = data.rideHistory.after[0] ?? null;
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
  const importedSpeed = imported.primary.some((stat) => stat.key === "speed");
  const derivedSpeed = speedKmh(data.row.distance_km, data.row.duration_min);
  const averageWattsPerKg = wattsPerKg(data.row.avg_power_w, data.bodyweightKg);
  const averageHeartRateZone = zonePresentation(data.activity.heart_rate_zone);
  const primaryStats = imported.primary.map((stat) => {
    if (stat.key === "power" && averageWattsPerKg != null) {
      return {
        ...stat,
        detail: [stat.detail, `${averageWattsPerKg} W/kg`]
          .filter(Boolean)
          .join(" · "),
      };
    }
    if (stat.key === "heart_rate" && averageHeartRateZone) {
      return {
        ...stat,
        detail: [`Average falls in ${averageHeartRateZone.name}`, stat.detail]
          .filter(Boolean)
          .join(" · "),
      };
    }
    return stat;
  });
  const recordedStats = [...primaryStats, ...imported.secondary];
  const energyAlreadyShown = imported.secondary.some(
    (stat) => stat.key === "active_kcal"
  );
  const fallbackEnergy =
    !energyAlreadyShown && data.calorieDisplay
      ? formatActivityCalories(data.calorieDisplay)
      : null;
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
  const zoneRows = data.zoneMinutes ? rideZoneRows(data.zoneMinutes) : [];
  const zoneTotal = zoneRows.reduce((sum, zone) => sum + zone.minutes, 0);
  const highlights = rideHighlights({
    zones: zoneRows,
    powerHrDriftPercent: data.dynamics?.powerHrDriftPercent ?? null,
    segments: data.indoorOnly ? [] : data.segmentEfforts,
  });
  const heartRateSeries = rideHeartRateSeries(
    data.heartRateWindow,
    data.heartRateMinutes
  );
  const comparisonMetrics: RideComparisonChartMetric[] =
    data.comparison?.metrics
      .filter((metric) => !data.indoorOnly || metric.key !== "elevation")
      .map((metric) => ({
        key: metric.key,
        label: COMPARISON_LABELS[metric.key],
        shortLabel: COMPARISON_SHORT_LABELS[metric.key],
        unit: comparisonChartUnit(metric.key, units.distanceUnit),
        decimals:
          metric.key === "speed" || metric.key === "relative_effort" ? 1 : 0,
        median: comparisonChartValue(
          metric.key,
          metric.median,
          units.distanceUnit
        ),
        points: metric.points.map((point) => ({
          ...point,
          value: comparisonChartValue(
            metric.key,
            point.value,
            units.distanceUnit
          ),
        })),
      })) ?? [];
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
  const rideSections = [
    { id: "overview", label: "Overview" },
    ...(hasEffort ? [{ id: "effort", label: "Effort" }] : []),
    ...(hasCourse ? [{ id: "course", label: "Course" }] : []),
    { id: "details", label: "Details" },
  ];
  const hasLinkedEffortCharts =
    telemetryTraces.length > 0 && heartRateSeries.length > 0;
  const hasTimedRoute =
    !data.indoorOnly && !!data.routePolyline && data.timedRoute.length > 1;
  const effortHoverHint = hasLinkedEffortCharts
    ? hasTimedRoute
      ? " Hover either effort chart to inspect the same moment and route position."
      : " Hover either effort chart to inspect the same moment."
    : hasTimedRoute
      ? " Hover the chart to follow the route position."
      : "";
  const sourceLabel = activityProvenanceLabel(data.row.source, data.row.edited);
  const editLocked =
    !!data.row.edited &&
    !!data.row.source &&
    data.row.source !== "manual" &&
    !data.row.source.startsWith(DOCUMENT_SOURCE_PREFIX);
  const timeText = activityTimeText(
    data.row.start_time,
    data.row.end_time,
    formatPrefs.timeFormat
  );

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="ride-detail"
    >
      <Link
        href={
          rideLens
            ? cyclingOverviewHref(rideLens)
            : data.activityName.trim().toLowerCase() === "cycling"
              ? CYCLING_OVERVIEW_HREF
              : cyclingOverviewHref({
                  metric: "distance",
                  range: "all",
                  activity: data.activityName,
                })
        }
        data-testid="ride-cycling-overview-link"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
      >
        <IconArrowLeft className="h-4 w-4" stroke={1.75} />
        {data.activityName} overview
      </Link>

      <PageHeader
        title={data.row.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <IconBike className="h-4 w-4" stroke={1.75} />
              {formatLongDate(data.row.date, formatPrefs)}
            </span>
            {timeText ? <span>· {timeText}</span> : null}
          </span>
        }
        action={
          <RideDetailActions
            activity={data.activity}
            canWrite={session.access === "write"}
          />
        }
        className="mb-3!"
      />

      <RideHeaderNavigation
        previous={previousRide}
        next={nextRide}
        formatPrefs={formatPrefs}
        distanceUnit={units.distanceUnit}
        lens={rideLens}
        noun={activityNoun}
      />

      <RideSectionNavigation sections={rideSections} />

      <RideChartLinkProvider>
        <section
          id="overview"
          className="scroll-mt-4"
          data-testid="ride-section-overview"
        >
          <RideSectionHeading first>Overview</RideSectionHeading>

          <CardGroup
            title={`${activityNoun === "ride" ? "Ride" : "Session"} summary`}
            data-testid="ride-summary"
          >
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {timing.activeMin != null ? (
                <StatBox
                  label="Active time"
                  value={`${timing.activeMin} min`}
                  sub={
                    timing.elapsedMin != null
                      ? `${timing.elapsedMin} min elapsed${
                          timing.restMin
                            ? ` · ${timing.restMin} min paused`
                            : ""
                        }`
                      : null
                  }
                  data-testid="ride-stat-active-time"
                />
              ) : null}
              {data.row.distance_km != null ? (
                <StatBox
                  label="Distance"
                  value={fmtDistance(data.row.distance_km, units.distanceUnit)}
                  data-testid="ride-stat-distance"
                />
              ) : null}
              {!importedSpeed && derivedSpeed != null ? (
                <StatBox
                  label="Average speed"
                  value={fmtKmh(derivedSpeed, units.distanceUnit)}
                  sub={summaryStatSub("speed")}
                  data-testid="ride-stat-speed"
                />
              ) : null}
              {data.row.intensity ? (
                <StatBox
                  label="Intensity"
                  value={data.row.intensity.replace(/^\w/, (value) =>
                    value.toUpperCase()
                  )}
                  data-testid="ride-stat-intensity"
                />
              ) : null}
              {data.equipment ? (
                <StatBox
                  label="Bike"
                  value={data.equipment.name}
                  href={equipmentHref(data.equipment.id)}
                  data-testid="ride-stat-bike"
                />
              ) : null}
            </dl>
            <RideHighlights highlights={highlights} noun={activityNoun} />
            {recordedStats.length > 0 || fallbackEnergy ? (
              <CardGroupSection className="max-sm:border-t-0">
                <dl
                  className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                  data-testid="ride-recorded-measurements"
                >
                  {recordedStats.map((stat) => (
                    <StatBox
                      key={stat.key}
                      label={stat.label}
                      value={stat.value}
                      valueStyle={
                        stat.key === "heart_rate" && averageHeartRateZone
                          ? { color: averageHeartRateZone.color }
                          : undefined
                      }
                      valueTitle={
                        stat.key === "heart_rate"
                          ? averageHeartRateZone?.title
                          : undefined
                      }
                      sub={summaryStatSub(stat.key, stat.detail)}
                      subClass={
                        stat.key === "heart_rate" && averageHeartRateZone
                          ? "font-medium text-slate-600 dark:text-slate-300"
                          : undefined
                      }
                      data-testid={statTestId(stat)}
                    />
                  ))}
                  {fallbackEnergy ? (
                    <StatBox
                      label="Energy"
                      value={fallbackEnergy}
                      data-testid="ride-stat-energy"
                    />
                  ) : null}
                </dl>
              </CardGroupSection>
            ) : null}
          </CardGroup>

          {data.comparison ? (
            <CardGroup
              title={`Compared with similar ${activityPlural}`}
              description={`Median of ${data.comparison.rideCount} similar ${
                data.comparison.rideCount === 1 ? activityNoun : activityPlural
              } within ${data.comparison.tolerancePercent}% of this ${activityNoun}’s ${
                data.comparison.basis
              }.`}
              className="mt-4"
              data-testid="ride-comparison"
            >
              <RideComparisonChart
                metrics={comparisonMetrics}
                lens={rideLens}
              />
            </CardGroup>
          ) : null}
        </section>

        {hasEffort ? (
          <section
            id="effort"
            className="scroll-mt-4 [&>div+section]:mt-0"
            data-testid="ride-section-effort"
          >
            <RideSectionHeading>Effort</RideSectionHeading>

            {telemetryTraces.length > 0 ? (
              <CardGroup
                title={`${activityNoun === "ride" ? "Ride" : "Session"} traces`}
                description={`Recorded sensor data over elapsed ${activityNoun} time.${effortHoverHint}`}
                className="mt-4"
                data-testid="ride-traces"
              >
                <RideTelemetryChart
                  traces={telemetryTraces}
                  initialMetric={rideLens?.metric}
                />
              </CardGroup>
            ) : null}

            {heartRateSeries.length > 0 ? (
              <CardGroup
                title="Heart rate"
                description={`One-minute readings recorded during this ${activityNoun}. A break in the line is a gap in wear.${effortHoverHint}`}
                className="mt-4"
                data-testid="ride-heart-rate"
                action={
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {data.heartRateMinutes.length} recorded min
                  </span>
                }
              >
                <div className="mt-4" data-testid="ride-heart-rate-chart">
                  <RideHeartRateChart
                    data={heartRateSeries}
                    rideDate={data.row.date}
                    zoneModel={data.zoneModel}
                  />
                </div>
                {zoneTotal > 0 ? (
                  <CardGroupSection>
                    <div data-testid="ride-heart-rate-zones">
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
                description="Derived from the recorded moving, power, grade, and heart-rate streams."
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
                description="Best rolling efforts and FTP-relative load from this ride’s recorded power."
                className="mt-4"
                data-testid="ride-power-profile"
              >
                {data.powerCurve.length > 0 ? (
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {data.powerCurve.map((point) => (
                      <StatBox
                        key={point.seconds}
                        label={`${point.label} best`}
                        value={`${point.watts} W`}
                        data-testid={`ride-power-curve-${point.seconds}`}
                      />
                    ))}
                  </dl>
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
                              title={`Zone ${zone.zone}: ${zone.percent}%`}
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
            className="scroll-mt-4 [&>div+section]:mt-0"
            data-testid="ride-section-course"
          >
            <RideSectionHeading>Course</RideSectionHeading>

            {data.routePolyline ? (
              <section className="mt-4" data-testid="ride-route">
                <h3 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">
                  Route
                </h3>
                <RideRouteMap
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
                                rideLens
                              )
                            : `/training/rides/${data.routeHistory.fastest.id}`
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
                description="Automatic distance splits derived from the recorded stream."
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
                            {split.index}
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
              </CardGroup>
            ) : null}

            {data.laps.length > 0 ? (
              <CardGroup title="Laps" className="mt-4" data-testid="ride-laps">
                <div className="mt-4">
                  <ResponsiveTable className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-black/10 text-left text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                        <th className="th">Lap</th>
                        <th className="th text-right">Distance</th>
                        <th className="th text-right">Time</th>
                        <th className="th text-right">Speed</th>
                        <th className="th text-right">Power</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.laps.map((lap) => (
                        <tr
                          key={lap.id}
                          className="border-b border-black/5 last:border-0 dark:border-white/5"
                        >
                          <Td slot="title" className="py-2.5 pr-3 font-medium">
                            {lap.name ?? `Lap ${lap.lapIndex}`}
                          </Td>
                          <Td
                            slot="value"
                            label="Distance"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {lap.distanceM == null
                              ? "—"
                              : fmtDistance(
                                  lap.distanceM / 1000,
                                  units.distanceUnit
                                )}
                          </Td>
                          <Td
                            slot="meta"
                            label="Time"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {formatElapsed(lap.movingTimeSec)}
                          </Td>
                          <Td
                            slot="meta"
                            label="Speed"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {lap.averageSpeedMps == null
                              ? "—"
                              : fmtKmh(
                                  lap.averageSpeedMps * 3.6,
                                  units.distanceUnit
                                )}
                          </Td>
                          <Td
                            slot="meta"
                            label="Power"
                            className="py-2.5 pl-3 text-right tabular-nums"
                          >
                            {lap.averageWatts == null
                              ? "—"
                              : `${Math.round(lap.averageWatts)} W`}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </ResponsiveTable>
                </div>
              </CardGroup>
            ) : null}

            {data.segmentEfforts.length > 0 ? (
              <CardGroup
                title="Segments"
                className="mt-4"
                data-testid="ride-segments"
              >
                <div className="mt-4">
                  <ResponsiveTable className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-black/10 text-left text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                        <th className="th">Segment</th>
                        <th className="th text-right">Distance</th>
                        <th className="th text-right">Time</th>
                        <th className="th text-right">Power</th>
                        <th className="th text-right">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.segmentEfforts.map((effort) => (
                        <tr
                          key={effort.id}
                          className="border-b border-black/5 last:border-0 dark:border-white/5"
                        >
                          <Td slot="title" className="py-2.5 pr-3 font-medium">
                            {effort.name}
                          </Td>
                          <Td
                            slot="value"
                            label="Distance"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {effort.distanceM == null
                              ? "—"
                              : fmtDistance(
                                  effort.distanceM / 1000,
                                  units.distanceUnit
                                )}
                          </Td>
                          <Td
                            slot="meta"
                            label="Time"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {formatElapsed(effort.movingTimeSec)}
                          </Td>
                          <Td
                            slot="meta"
                            label="Power"
                            className="px-3 py-2.5 text-right tabular-nums"
                          >
                            {effort.averageWatts == null
                              ? "—"
                              : `${Math.round(effort.averageWatts)} W`}
                          </Td>
                          <Td
                            slot="meta"
                            label="Result"
                            className="py-2.5 pl-3 text-right font-medium"
                          >
                            {effort.komRank
                              ? `KOM #${effort.komRank}`
                              : effort.prRank
                                ? `PR #${effort.prRank}`
                                : "—"}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </ResponsiveTable>
                </div>
              </CardGroup>
            ) : null}
          </section>
        ) : null}

        <section
          id="details"
          className="scroll-mt-4 [&>div+section]:mt-0"
          data-testid="ride-section-details"
        >
          <RideSectionHeading>Details</RideSectionHeading>

          {data.row.notes ? (
            <CardGroup title="Notes" className="mt-4" data-testid="ride-notes">
              <NotesText
                notes={data.row.notes}
                as="p"
                className="mt-3 text-sm leading-6 text-slate-700 dark:text-slate-200"
              />
            </CardGroup>
          ) : null}

          <ActivityProvenance
            label={sourceLabel}
            createdAt={data.row.created_at}
            updatedAt={data.row.updated_at}
            editLockId={editLocked ? data.row.id : undefined}
            variant="quiet"
            className="mt-4"
          />
        </section>
      </RideChartLinkProvider>
    </PageContainer>
  );
}
