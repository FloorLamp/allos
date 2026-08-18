import type { DistanceUnit } from "./settings";
import { kmTo } from "./units";
import { trainingActivityPageHref, type AppRoute } from "./hrefs";
import type {
  SessionComparison,
  SessionComparisonMetricKey,
} from "./session-detail";

export interface SessionComparisonMetricView {
  key: SessionComparisonMetricKey;
  label: string;
  shortLabel: string;
  unit: string;
  decimals: number;
  median: number;
  points: {
    id: number;
    date: string;
    title: string;
    value: number;
    current: boolean;
    href: AppRoute;
  }[];
}

const LABELS: Record<SessionComparisonMetricKey, string> = {
  speed: "Average speed",
  heart_rate: "Average heart rate",
  power: "Average power",
  weighted_power: "Weighted power",
  cadence: "Average cadence",
  elevation: "Elevation gain",
  relative_effort: "Relative effort",
};

const SHORT_LABELS: Record<SessionComparisonMetricKey, string> = {
  speed: "Speed",
  heart_rate: "Heart rate",
  power: "Power",
  weighted_power: "Weighted power",
  cadence: "Cadence",
  elevation: "Elevation",
  relative_effort: "Effort",
};

function unit(
  key: SessionComparisonMetricKey,
  distanceUnit: DistanceUnit
): string {
  if (key === "speed") return ` ${distanceUnit}/h`;
  if (key === "heart_rate") return " bpm";
  if (key === "power" || key === "weighted_power") return " W";
  if (key === "cadence") return " rpm";
  if (key === "elevation") return distanceUnit === "mi" ? " ft" : " m";
  return "";
}

function value(
  key: SessionComparisonMetricKey,
  input: number,
  distanceUnit: DistanceUnit
): number {
  if (key === "speed") return kmTo(input, distanceUnit);
  if (key === "elevation" && distanceUnit === "mi") return input * 3.28084;
  return input;
}

export function sessionComparisonChartMetrics(
  comparison: SessionComparison | null,
  distanceUnit: DistanceUnit
): SessionComparisonMetricView[] {
  return (
    comparison?.metrics.map((metric) => ({
      key: metric.key,
      label: LABELS[metric.key],
      shortLabel: SHORT_LABELS[metric.key],
      unit: unit(metric.key, distanceUnit),
      decimals:
        metric.key === "speed" || metric.key === "relative_effort" ? 1 : 0,
      median: value(metric.key, metric.median, distanceUnit),
      points: metric.points.map((point) => ({
        ...point,
        value: value(metric.key, point.value, distanceUnit),
        href: trainingActivityPageHref(point.id),
      })),
    })) ?? []
  );
}
