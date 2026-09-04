"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";
import type { TimeSeriesSpec } from "./chart-spec";

// THE CODE-SPLIT SEAM, one per renderer instead of one per card (#4925). See
// BarSeriesChart.tsx for why it is shaped this way; the two are the same seam.
const TimeSeriesChartInner = dynamic(() => import("./TimeSeriesChartInner"), {
  ssr: false,
});

export default function TimeSeriesChart({ spec }: { spec: TimeSeriesSpec }) {
  return (
    <ChartErrorBoundary
      fallback={<ChartUnavailable heightClass={spec.frame.heightClass} />}
    >
      <Suspense
        fallback={<ChartLoading heightClass={spec.frame.heightClass} />}
      >
        <TimeSeriesChartInner spec={spec} />
      </Suspense>
    </ChartErrorBoundary>
  );
}
