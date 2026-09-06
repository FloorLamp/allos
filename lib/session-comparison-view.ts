import type { DistanceUnit } from "./settings";
import {
  comparisonDecimals,
  comparisonDisplayValue,
  comparisonUnitSuffix,
} from "./session-comparison-format";
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

export function sessionComparisonChartMetrics(
  comparison: SessionComparison | null,
  distanceUnit: DistanceUnit
): SessionComparisonMetricView[] {
  return (
    comparison?.metrics.map((metric) => ({
      key: metric.key,
      label: LABELS[metric.key],
      shortLabel: SHORT_LABELS[metric.key],
      unit: comparisonUnitSuffix(metric.key, distanceUnit),
      decimals: comparisonDecimals(metric.key),
      median: comparisonDisplayValue(metric.key, metric.median, distanceUnit),
      points: metric.points.map((point) => ({
        ...point,
        value: comparisonDisplayValue(metric.key, point.value, distanceUnit),
        href: trainingActivityPageHref(point.id),
      })),
    })) ?? []
  );
}
