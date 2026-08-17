"use client";

// Cycling comparison extra for the canonical activity detail page.

import SessionComparisonChart from "@/components/SessionComparisonChart";
import {
  cyclingRideHref,
  trainingActivityPageHref,
  type CyclingLens,
} from "@/lib/hrefs";
import type { SessionComparisonMetricKey } from "@/lib/session-detail";

export interface RideComparisonChartMetric {
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
  }[];
}

// Compatibility formatter for the cycling tenant. The chart itself is the
// shared session treatment used by every canonical activity page.
export default function RideComparisonChart({
  metrics,
  lens,
}: {
  metrics: RideComparisonChartMetric[];
  lens: CyclingLens | null;
}) {
  return (
    <SessionComparisonChart
      noun="rides"
      singularNoun="ride"
      testIdPrefix="ride-comparison"
      initialMetric={
        metrics.some((metric) => metric.key === lens?.metric)
          ? (lens?.metric as SessionComparisonMetricKey)
          : null
      }
      metrics={metrics.map((metric) => ({
        ...metric,
        points: metric.points.map((point) => ({
          ...point,
          href: lens
            ? cyclingRideHref(point.id, lens)
            : trainingActivityPageHref(point.id),
        })),
      }))}
    />
  );
}
