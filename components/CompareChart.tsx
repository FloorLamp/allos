"use client";

import dynamic from "next/dynamic";
import ChartLoading from "./ChartLoading";

// recharts is large; code-split it out of the initial JS. Client-only chart, so
// ssr:false is free.
const CompareChart = dynamic(() => import("./CompareChartInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-72" />,
});

export default CompareChart;
