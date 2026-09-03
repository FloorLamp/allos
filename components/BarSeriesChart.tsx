"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";
import type { BarSeriesSpec } from "./chart-spec";

// THE CODE-SPLIT SEAM, one per renderer instead of one per card (#4925).
//
// recharts is large, so it loads only when a chart actually draws. The renderer
// is client-only anyway (ResponsiveContainer needs a real DOM box to size
// against), so `ssr: false` costs nothing. The `dynamic()` call lives in this
// "use client" module so a server page can import a card unchanged — and the
// SPEC crossing this boundary is plain data (see chart-spec.ts), which is what
// keeps recharts out of a page that draws no chart.
const BarSeriesChartInner = dynamic(() => import("./BarSeriesChartInner"), {
  ssr: false,
});

// A failed chunk fetch (the browser went offline before the lazy import
// resolved) degrades to an inline placeholder, never the route error page. Both
// placeholders honor the spec's own height, so a chunk arriving late does not
// jump the layout (#407).
export default function BarSeriesChart({ spec }: { spec: BarSeriesSpec }) {
  return (
    <ChartErrorBoundary
      fallback={<ChartUnavailable heightClass={spec.frame.heightClass} />}
    >
      <Suspense
        fallback={<ChartLoading heightClass={spec.frame.heightClass} />}
      >
        <BarSeriesChartInner spec={spec} />
      </Suspense>
    </ChartErrorBoundary>
  );
}
