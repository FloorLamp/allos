"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS. Client-only chart, so
// ssr:false is free.
const CompareChartInner = dynamic(() => import("./CompareChartInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-72" />,
});

// A failed chunk fetch (e.g. the browser went offline before the lazy import
// resolved) must degrade to an inline placeholder, never the route error page —
// see ChartErrorBoundary.
export default function CompareChart(
  props: ComponentProps<typeof CompareChartInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-72" />}>
      <CompareChartInner {...props} />
    </ChartErrorBoundary>
  );
}
