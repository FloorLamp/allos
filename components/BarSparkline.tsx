"use client";

import dynamic from "next/dynamic";
import { Suspense, type ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS, exactly as every sibling
// chart wrapper does. Client-only (ResponsiveContainer needs a real DOM box), so
// ssr:false is free, and the dynamic() call lives in this "use client" wrapper so a
// Server Component (TrendMiniCard) can import <BarSparkline> unchanged.
const BarSparklineInner = dynamic(() => import("./BarSparklineInner"), {
  ssr: false,
});

// A failed chunk fetch must degrade to an inline placeholder at the CALLER's
// height, never the route error page (see ChartErrorBoundary) — the tile is ~80px
// tall, so a hardcoded h-64 fallback would be a 180px layout jump.
export default function BarSparkline(
  props: ComponentProps<typeof BarSparklineInner>
) {
  const heightClass = props.heightClass ?? "h-20";
  return (
    <ChartErrorBoundary
      fallback={<ChartUnavailable heightClass={heightClass} />}
    >
      <Suspense fallback={<ChartLoading heightClass={heightClass} />}>
        <BarSparklineInner {...props} />
      </Suspense>
    </ChartErrorBoundary>
  );
}
