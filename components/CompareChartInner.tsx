"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { formatLongDate } from "@/lib/format-date";
import {
  ANNOTATION_KIND_META,
  snapAnnotationsToDates,
  type TrendAnnotation,
} from "@/lib/trend-annotations";

// Dual-series overlay for the Trends Compare tab. Plots two
// date-aligned series on one time axis so correlation is eyeball-able. When the
// units differ we use a DUAL Y-axis (A left, B right); when `normalized`, both
// series are already min-max scaled to 0–1 by the caller, so they share ONE 0–100%
// axis. Nulls (a date where only one series has a reading) are bridged with
// connectNulls. Styling matches LineChartCard.
export default function CompareChart({
  data,
  labelA,
  labelB,
  colorA,
  colorB,
  unitA,
  unitB,
  normalized,
  annotations,
}: {
  data: { date: string; a: number | null; b: number | null }[];
  labelA: string;
  labelB: string;
  colorA: string;
  colorB: string;
  unitA: string;
  unitB: string;
  normalized: boolean;
  // Event annotations, pre-filtered to the enabled kinds by
  // the parent; drawn as vertical reference lines snapped to the nearest charted date.
  annotations?: TrendAnnotation[];
}) {
  const c = useChartColors();
  const snapped = annotations?.length
    ? snapAnnotationsToDates(
        annotations,
        data.map((d) => d.date)
      )
    : [];
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
        No overlapping data in this range
      </div>
    );
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => v.slice(5)}
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 11, fill: normalized ? c.tick : colorA }}
            stroke={normalized ? c.axis : colorA}
            domain={normalized ? [0, 1] : ["auto", "auto"]}
            tickFormatter={normalized ? pct : undefined}
          />
          {!normalized && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11, fill: colorB }}
              stroke={colorB}
              domain={["auto", "auto"]}
            />
          )}
          <Tooltip
            formatter={(v: number, name: string) => [
              normalized ? pct(v) : `${v}${name === labelA ? unitA : unitB}`,
              name,
            ]}
            labelFormatter={(v: string) => formatLongDate(v)}
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
          {snapped.map((a, i) => (
            <ReferenceLine
              key={`ann-${a.kind}-${a.date}-${i}`}
              yAxisId="left"
              x={a.date}
              stroke={ANNOTATION_KIND_META[a.kind].color}
              strokeDasharray="3 3"
              strokeOpacity={0.85}
              label={{
                value: a.label,
                position: "top",
                fontSize: 9,
                fill: ANNOTATION_KIND_META[a.kind].color,
              }}
            />
          ))}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="a"
            name={labelA}
            stroke={colorA}
            strokeWidth={2}
            dot={{ r: 2, fill: colorA, stroke: colorA }}
            connectNulls
          />
          <Line
            yAxisId={normalized ? "left" : "right"}
            type="monotone"
            dataKey="b"
            name={labelB}
            stroke={colorB}
            strokeWidth={2}
            dot={{ r: 2, fill: colorB, stroke: colorB }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
