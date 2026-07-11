"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS (mirrors LineChartCard).
const SourceCompareChartInner = dynamic(
  () => import("./SourceCompareChartInner"),
  {
    ssr: false,
    loading: () => <ChartLoading heightClass="h-64" />,
  }
);

export default function SourceCompareChart(
  props: ComponentProps<typeof SourceCompareChartInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-64" />}>
      <SourceCompareChartInner {...props} />
    </ChartErrorBoundary>
  );
}
