import { chartSeries } from "./chart-colors";
import type { CardioMetric } from "./analyze-view";

export interface CyclingMetricPresentation {
  label: string;
  historyLabel: string;
  color: (typeof chartSeries)[keyof typeof chartSeries];
}

// One visual and naming contract for the aggregate Cycling page and every
// ride-level chart/comparison. A metric keeps its identity as the reader moves
// between the two surfaces.
export const CYCLING_METRICS: Record<CardioMetric, CyclingMetricPresentation> =
  {
    distance: {
      label: "Distance",
      historyLabel: "Distance",
      color: chartSeries.sky,
    },
    duration: {
      label: "Duration",
      historyLabel: "Duration",
      color: chartSeries.sky,
    },
    speed: {
      label: "Speed",
      historyLabel: "Avg speed",
      color: chartSeries.sky,
    },
    elevation: {
      label: "Elevation",
      historyLabel: "Elevation",
      color: chartSeries.violet,
    },
    heart_rate: {
      label: "Heart rate",
      historyLabel: "Heart rate",
      color: chartSeries.rose,
    },
    power: {
      label: "Power",
      historyLabel: "Power",
      color: chartSeries.amber,
    },
    weighted_power: {
      label: "Weighted power",
      historyLabel: "Weighted power",
      color: chartSeries.violet,
    },
    cadence: {
      label: "Cadence",
      historyLabel: "Cadence",
      color: chartSeries.brand,
    },
    relative_effort: {
      label: "Effort",
      historyLabel: "Effort",
      color: chartSeries.amber,
    },
  };

const HISTORY_ORDER: CardioMetric[] = [
  "distance",
  "duration",
  "speed",
  "heart_rate",
  "power",
  "elevation",
  "weighted_power",
  "cadence",
  "relative_effort",
];

export function cyclingHistoryMetricOrder(
  active: CardioMetric,
  available: readonly CardioMetric[]
): CardioMetric[] {
  const allowed = new Set(available);
  return [active, ...HISTORY_ORDER].filter(
    (metric, index, rows) =>
      allowed.has(metric) && rows.indexOf(metric) === index
  );
}
