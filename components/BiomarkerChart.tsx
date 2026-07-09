"use client";

import dynamic from "next/dynamic";
import ChartLoading from "./ChartLoading";

// recharts is large; load it only when the chart actually renders. The chart is
// client-only anyway (it needs the browser to size the ResponsiveContainer), so
// ssr:false costs nothing and keeps recharts out of the initial JS of the
// biomarker / analytics routes. Types are re-exported so import sites are
// unchanged (`import BiomarkerChart, { BiomarkerBands }`).
export type { BiomarkerBands } from "./BiomarkerChartInner";

const BiomarkerChart = dynamic(() => import("./BiomarkerChartInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

export default BiomarkerChart;
