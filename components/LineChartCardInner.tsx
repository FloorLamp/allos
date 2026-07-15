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
import { chartSeries } from "@/lib/chart-colors";
import { formatLongDate } from "@/lib/format-date";
import { roundChartValue } from "@/lib/chart-format";
import {
  ANNOTATION_KIND_META,
  snapAnnotationsToDates,
  type TrendAnnotation,
} from "@/lib/trend-annotations";

// A full ISO date (YYYY-MM-DD) — distinguishes date series (which get the
// compact-axis + friendly-tooltip default below) from time/category x-values.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function LineChartCard({
  data,
  dataKey,
  label,
  color = chartSeries.brand,
  unit = "",
  showDots = true,
  tickFormatter,
  labelFormatter,
  heightClass = "h-64",
  annotations,
  referenceValue,
  decimals,
  yDomain,
}: {
  data: { date: string; value: number | null }[];
  dataKey?: string;
  label: string;
  color?: string;
  unit?: string;
  // An explicit numeric Y domain [lo, hi] (issue #407). When set it replaces
  // recharts' ["auto","auto"] — the biomarker sparkline threads the SHARED
  // axis-domain policy (biomarkerAxisDomain) through so a pinned-biomarker tile and
  // the biomarker DETAIL chart scale the same series identically (0-clamped for a
  // non-negative analyte; a flat series gets a small window). Omitted → auto.
  yDomain?: [number, number];
  // Display precision for the tooltip value, so it reads the same rounded number
  // as the caller's headline/table (issue #403). Omitted → cap at 2 decimals.
  decimals?: number;
  // Disable per-point dots for dense series (e.g. ~1440 intraday HR points).
  showDots?: boolean;
  // Optional: compact the x-axis tick, and expand the tooltip's date label.
  tickFormatter?: (value: string) => string;
  labelFormatter?: (value: string) => string;
  // Chart height (Tailwind class); shrink for compact/secondary charts.
  heightClass?: string;
  // Event annotations, pre-filtered to the enabled kinds by
  // the parent. Drawn as vertical reference lines, snapped to the nearest charted
  // date (recharts positions a category-axis ReferenceLine only on an actual point).
  annotations?: TrendAnnotation[];
  // A horizontal target line (e.g. a goal's target value, in this chart's unit).
  referenceValue?: { value: number; label?: string; color?: string } | null;
}) {
  const key = dataKey ?? "value";
  const c = useChartColors();
  // For ISO-date series, default to a compact MM-DD axis and a friendly long
  // date in the tooltip (matching the journal charts). Callers passing their own
  // formatters, or non-date x-values (e.g. HH:MM intraday), are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(data[0].date);
  const tickFmt =
    tickFormatter ?? (isoDates ? (v: string) => v.slice(5) : undefined);
  const labelFmt =
    labelFormatter ?? (isoDates ? (v: string) => formatLongDate(v) : undefined);
  // Snap annotation markers onto charted dates so their vertical ReferenceLines
  // land on the category axis (recharts otherwise drops an off-point x).
  const snapped = annotations?.length
    ? snapAnnotationsToDates(
        annotations,
        data.map((d) => d.date)
      )
    : [];
  if (data.length === 0) {
    return (
      <div
        className={`flex ${heightClass} items-center justify-center text-sm text-slate-500 dark:text-slate-400`}
      >
        No data yet
      </div>
    );
  }
  return (
    <div className={`${heightClass} w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
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
            domain={yDomain ?? ["auto", "auto"]}
          />
          <Tooltip
            formatter={(v) => [
              `${roundChartValue(Number(v), decimals)}${unit}`,
              label,
            ]}
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
          {referenceValue != null && (
            <ReferenceLine
              y={referenceValue.value}
              stroke={referenceValue.color ?? chartSeries.emerald}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              label={
                referenceValue.label
                  ? {
                      value: referenceValue.label,
                      position: "insideTopLeft",
                      fontSize: 10,
                      fill: referenceValue.color ?? chartSeries.emerald,
                    }
                  : undefined
              }
            />
          )}
          {snapped.map((a, i) => (
            <ReferenceLine
              key={`ann-${a.kind}-${a.date}-${i}`}
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
            type="monotone"
            dataKey={key}
            stroke={color}
            strokeWidth={2}
            dot={showDots ? { r: 3, fill: color, stroke: color } : false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
