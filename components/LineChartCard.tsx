"use client";

import dynamic from "next/dynamic";
import ChartLoading from "./ChartLoading";

// recharts is large; code-split it out of the initial JS. This chart is
// client-only (ResponsiveContainer needs a real DOM box to size against), so
// ssr:false is free. The dynamic() call lives in this "use client" wrapper, so
// server-component pages can still import <LineChartCard> unchanged.
const LineChartCard = dynamic(() => import("./LineChartCardInner"), {
  ssr: false,
  loading: () => <ChartLoading heightClass="h-64" />,
});

export default LineChartCard;
