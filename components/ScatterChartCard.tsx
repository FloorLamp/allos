"use client";

import dynamic from "next/dynamic";
import { Suspense, type ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// Shared, client-only scatter primitive. Keep Recharts behind the same lazy/error
// boundary as the other chart cards so a relationship view does not inflate the
// initial server bundle or take down its page when the chart chunk is unavailable.
const ScatterChartCardInner = dynamic(() => import("./ScatterChartCardInner"), {
  ssr: false,
});

export default function ScatterChartCard(
  props: ComponentProps<typeof ScatterChartCardInner>
) {
  const heightClass = props.heightClass ?? "h-64";
  return (
    <ChartErrorBoundary
      fallback={<ChartUnavailable heightClass={heightClass} />}
    >
      <Suspense fallback={<ChartLoading heightClass={heightClass} />}>
        <ScatterChartCardInner {...props} />
      </Suspense>
    </ChartErrorBoundary>
  );
}
