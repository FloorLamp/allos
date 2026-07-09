"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; load it only when the chart actually renders. The chart is
// client-only anyway (it needs the browser to size the ResponsiveContainer), so
// ssr:false costs nothing and keeps recharts out of the initial JS of the
// biomarker / analytics routes. Types are re-exported so import sites are
// unchanged (`import BiomarkerChart, { BiomarkerBands }`).
export type { BiomarkerBands } from "./BiomarkerChartInner";

const BiomarkerChartInner = dynamic(() => import("./BiomarkerChartInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

// A failed chunk fetch (e.g. the browser went offline before the lazy import
// resolved) must degrade to an inline placeholder, never the route error page —
// see ChartErrorBoundary.
export default function BiomarkerChart(
  props: ComponentProps<typeof BiomarkerChartInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-64" />}>
      <BiomarkerChartInner {...props} />
    </ChartErrorBoundary>
  );
}
