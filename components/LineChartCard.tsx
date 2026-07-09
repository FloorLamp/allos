"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS. This chart is
// client-only (ResponsiveContainer needs a real DOM box to size against), so
// ssr:false is free. The dynamic() call lives in this "use client" wrapper, so
// server-component pages can still import <LineChartCard> unchanged.
const LineChartCardInner = dynamic(() => import("./LineChartCardInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

// A failed chunk fetch (e.g. the browser went offline before the lazy import
// resolved) must degrade to an inline placeholder, never the route error page —
// see ChartErrorBoundary.
export default function LineChartCard(
  props: ComponentProps<typeof LineChartCardInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-64" />}>
      <LineChartCardInner {...props} />
    </ChartErrorBoundary>
  );
}
