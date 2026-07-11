"use client";

import dynamic from "next/dynamic";
import { Suspense, type ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS. This chart is
// client-only (ResponsiveContainer needs a real DOM box to size against), so
// ssr:false is free. The dynamic() call lives in this "use client" wrapper, so
// server-component pages can still import <LineChartCard> unchanged.
const LineChartCardInner = dynamic(() => import("./LineChartCardInner"), {
  ssr: false,
});

// A failed chunk fetch (e.g. the browser went offline before the lazy import
// resolved) must degrade to an inline placeholder, never the route error page —
// see ChartErrorBoundary. Both placeholders honor the caller's `heightClass`
// (issue #407): the inner chart shrinks to h-40 / h-24 for the dashboard tiles, so
// a hardcoded h-64 loading/offline box caused a 100px+ layout jump on every load
// and an offline fallback ~3× the widget's chart box. The dynamic loading state is
// the Suspense fallback (not next/dynamic's fixed `loading`, which can't see props)
// so it, too, matches the target height.
export default function LineChartCard(
  props: ComponentProps<typeof LineChartCardInner>
) {
  const heightClass = props.heightClass ?? "h-64";
  return (
    <ChartErrorBoundary
      fallback={<ChartUnavailable heightClass={heightClass} />}
    >
      <Suspense fallback={<ChartLoading heightClass={heightClass} />}>
        <LineChartCardInner {...props} />
      </Suspense>
    </ChartErrorBoundary>
  );
}
