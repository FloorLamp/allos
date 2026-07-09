"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS. Client-only chart, so
// ssr:false is free. Types re-exported so import sites stay unchanged
// (`import GrowthChart, { GrowthBand, GrowthPlotPoint }`).
export type { GrowthBand, GrowthPlotPoint } from "./GrowthChartInner";

const GrowthChartInner = dynamic(() => import("./GrowthChartInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-72" />,
});

// A failed chunk fetch (e.g. the browser went offline before the lazy import
// resolved) must degrade to an inline placeholder, never the route error page —
// see ChartErrorBoundary.
export default function GrowthChart(
  props: ComponentProps<typeof GrowthChartInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-72" />}>
      <GrowthChartInner {...props} />
    </ChartErrorBoundary>
  );
}
