"use client";

import dynamic from "next/dynamic";
import ChartLoading from "./ChartLoading";

// recharts is large; code-split it out of the initial JS. Client-only chart, so
// ssr:false is free. Types re-exported so import sites stay unchanged
// (`import GrowthChart, { GrowthBand, GrowthPlotPoint }`).
export type { GrowthBand, GrowthPlotPoint } from "./GrowthChartInner";

const GrowthChart = dynamic(() => import("./GrowthChartInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-72" />,
});

export default GrowthChart;
