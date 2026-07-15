"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { formatLongDate } from "@/lib/format-date";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StackedSeries {
  key: string;
  label: string;
  color: string;
}

// A stacked bar chart over a date axis. Each datum is { date, [key]: number, ... }.
// Used for sleep-stage composition, nutrition macros, and weekly cardio volume.
export default function StackedBarCard({
  data,
  series,
  unit = "",
  labelPrefix = "",
}: {
  data: Record<string, number | string>[];
  series: StackedSeries[];
  unit?: string;
  // Prefix for the tooltip's date label, e.g. "Week of " → "Week of June 8".
  labelPrefix?: string;
}) {
  const c = useChartColors();
  // For ISO-date series, compact the axis to MM-DD and show a friendly long date
  // in the tooltip (matching LineChartCard). Callers passing pre-shortened MM-DD
  // dates are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(String(data[0].date));
  const tickFmt = isoDates ? (v: string) => String(v).slice(5) : undefined;
  const labelFmt = isoDates
    ? (v: string) => `${labelPrefix}${formatLongDate(String(v))}`
    : undefined;
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        No data yet
      </div>
    );
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tickFormatter={tickFmt}
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
          />
          <YAxis
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
            unit={unit}
          />
          <Tooltip
            cursor={{ fill: c.grid, fillOpacity: 0.5 }}
            formatter={(v, name) => [`${v}${unit}`, name]}
            labelFormatter={labelFmt ? (v) => labelFmt(String(v)) : undefined}
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              color: c.tooltipText,
            }}
            labelStyle={{ color: c.tooltipText }}
            itemStyle={{ color: c.tooltipText }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="stack"
              fill={s.color}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
