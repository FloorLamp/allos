"use client";

import dynamic from "next/dynamic";
import ChartLoading from "./ChartLoading";

// recharts is large; code-split it out of the initial JS. Client-only chart, so
// ssr:false is free. Types re-exported so import sites stay unchanged.
export type { StackedSeries } from "./StackedBarCardInner";

const StackedBarCard = dynamic(() => import("./StackedBarCardInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

export default StackedBarCard;
