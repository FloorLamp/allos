"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS. Client-only chart, so
// ssr:false is free. Types re-exported so import sites stay unchanged.
export type { StackedSeries } from "./StackedBarCardInner";

const StackedBarCardInner = dynamic(() => import("./StackedBarCardInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

// A failed chunk fetch (e.g. the browser went offline before the lazy import
// resolved) must degrade to an inline placeholder, never the route error page —
// see ChartErrorBoundary. Every sibling chart wrapper does this; StackedBarCard
// was the one twin that skipped it (issue #401).
export default function StackedBarCard(
  props: ComponentProps<typeof StackedBarCardInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-64" />}>
      <StackedBarCardInner {...props} />
    </ChartErrorBoundary>
  );
}
