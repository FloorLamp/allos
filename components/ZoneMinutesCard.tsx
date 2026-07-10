"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import ChartLoading from "./ChartLoading";
import ChartErrorBoundary, { ChartUnavailable } from "./ChartErrorBoundary";

// recharts is large; code-split it out of the initial JS. Client-only (the chart
// sizes against a real DOM box), so ssr:false is free. The dynamic() call lives in
// this "use client" wrapper so server-component pages import <ZoneMinutesCard>
// unchanged. A failed chunk fetch degrades to an inline placeholder, never the
// route error page — see ChartErrorBoundary.
export type { ZoneWeekDatum } from "./ZoneMinutesCardInner";

const ZoneMinutesCardInner = dynamic(() => import("./ZoneMinutesCardInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

export default function ZoneMinutesCard(
  props: ComponentProps<typeof ZoneMinutesCardInner>
) {
  return (
    <ChartErrorBoundary fallback={<ChartUnavailable heightClass="h-64" />}>
      <ZoneMinutesCardInner {...props} />
    </ChartErrorBoundary>
  );
}
