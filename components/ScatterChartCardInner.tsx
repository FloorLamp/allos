"use client";

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { chartSeries } from "@/lib/chart-colors";
import { roundChartValue } from "@/lib/chart-format";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useChartColors } from "./useChartColors";

export interface ScatterPoint {
  x: number;
  y: number;
  date?: string;
}

// Generic two-variable relationship chart. Every dot is one paired observation;
// an optional ISO date is tooltip context and does not control either axis.
export default function ScatterChartCard({
  data,
  xLabel,
  yLabel,
  xUnit = "",
  yUnit = "",
  xDecimals,
  yDecimals,
  xDomain,
  yDomain,
  color = chartSeries.brand,
  heightClass = "h-64",
}: {
  data: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xUnit?: string;
  yUnit?: string;
  xDecimals?: number;
  yDecimals?: number;
  xDomain?: [number, number];
  yDomain?: [number, number];
  color?: string;
  heightClass?: string;
}) {
  const formatPrefs = useFormatPrefs();
  const c = useChartColors();

  if (data.length === 0) {
    return (
      <div
        className={`flex ${heightClass} items-center justify-center text-sm text-slate-500 dark:text-slate-400`}
      >
        No paired data yet
      </div>
    );
  }

  return (
    <div
      className={`${heightClass} min-w-0 max-w-full`}
      data-testid="scatter-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            domain={xDomain ?? ["auto", "auto"]}
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
            label={{
              value: xLabel,
              position: "insideBottom",
              offset: -12,
              fontSize: 11,
              fill: c.tick,
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={yLabel}
            domain={yDomain ?? ["auto", "auto"]}
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
            label={{
              value: yLabel,
              angle: -90,
              position: "insideLeft",
              fontSize: 11,
              fill: c.tick,
            }}
          />
          <Tooltip
            cursor={{ stroke: c.axis, strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as ScatterPoint;
              return (
                <div
                  className="rounded-lg border p-2 text-xs shadow-sm"
                  style={{
                    background: c.tooltipBg,
                    borderColor: c.tooltipBorder,
                    color: c.tooltipText,
                  }}
                >
                  {point.date && (
                    <p className="mb-1 font-medium">
                      {formatLongDate(point.date, formatPrefs)}
                    </p>
                  )}
                  <p>
                    {xLabel}: {roundChartValue(point.x, xDecimals)}
                    {xUnit}
                  </p>
                  <p>
                    {yLabel}: {roundChartValue(point.y, yDecimals)}
                    {yUnit}
                  </p>
                </div>
              );
            }}
          />
          <Scatter data={data} fill={color} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
