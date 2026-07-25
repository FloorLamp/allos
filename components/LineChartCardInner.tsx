"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import {
  chartActiveDot,
  chartAnnotationLabel,
  chartAxisProps,
  chartDash,
  chartFullMargin,
  chartGridProps,
  chartLineDot,
  chartMarkMotion,
  chartSparklineAxisProps,
  chartSparklineMargin,
  chartTooltipProps,
  useChartMotion,
} from "./chart-scaffold";
import { chartSeries } from "@/lib/chart-colors";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { roundChartValue } from "@/lib/chart-format";
import {
  ANNOTATION_KIND_META,
  snapAnnotationsToDates,
  snapWindowsToDates,
  type TrendAnnotation,
  type TrendWindow,
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
  windows,
  referenceValue,
  decimals,
  yDomain,
  syncId,
  sparkline = false,
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
  // Charts with the same id share hover position/tooltip alignment (used by the
  // paired sleep + mood panels so the same date is compared in both).
  syncId?: string;
  // Display precision for the tooltip value, so it reads the same rounded number
  // as the caller's headline/table (issue #403). Omitted → cap at 2 decimals.
  decimals?: number;
  // Hard override to disable per-point dots. Dots also turn themselves off above
  // DENSE_SERIES_POINTS (issue #1445) — this stays for callers that know their
  // series is dense regardless (e.g. ~1440 intraday HR points).
  showDots?: boolean;
  // Optional: compact the x-axis tick, and expand the tooltip's date label.
  tickFormatter?: (value: string) => string;
  labelFormatter?: (value: string) => string;
  // Chart height (Tailwind class); shrink for compact/secondary charts.
  heightClass?: string;
  // Sparkline mode (#1445): drop the grid and BOTH axes (they still scale the
  // series, they just stop painting themselves and stop reserving space) and pull
  // the margins to near-zero, so a mini tile spends its pixels on the plot rather
  // than on axis chrome that is unreadable at tile width. The caller supplies the
  // numbers the axes would have carried as inline text — see TrendMiniCard.
  sparkline?: boolean;
  // Event annotations, pre-filtered to the enabled kinds by
  // the parent. Drawn as vertical reference lines, snapped to the nearest charted
  // date (recharts positions a category-axis ReferenceLine only on an actual point).
  annotations?: TrendAnnotation[];
  // Protocol intervention windows (issue #660), pre-filtered to the enabled kinds by
  // the parent. Drawn as a shaded ReferenceArea from start to end, snapped to the
  // charted category dates (recharts positions a category-axis area only on real
  // points).
  windows?: TrendWindow[];
  // A horizontal target line (e.g. a goal's target value, in this chart's unit).
  referenceValue?: { value: number; label?: string; color?: string } | null;
}) {
  const formatPrefs = useFormatPrefs();
  const key = dataKey ?? "value";
  const c = useChartColors();
  const motion = useChartMotion();
  // For ISO-date series, default to a compact MM-DD axis and a friendly long
  // date in the tooltip (matching the journal charts). Callers passing their own
  // formatters, or non-date x-values (e.g. HH:MM intraday), are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(data[0].date);
  const tickFmt =
    tickFormatter ?? (isoDates ? (v: string) => v.slice(5) : undefined);
  const labelFmt =
    labelFormatter ??
    (isoDates ? (v: string) => formatLongDate(v, formatPrefs) : undefined);
  // Snap annotation markers onto charted dates so their vertical ReferenceLines
  // land on the category axis (recharts otherwise drops an off-point x).
  const snapped = annotations?.length
    ? snapAnnotationsToDates(
        annotations,
        data.map((d) => d.date)
      )
    : [];
  const snappedWindows = windows?.length
    ? snapWindowsToDates(
        windows,
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
    <div className={`${heightClass} min-w-0 max-w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          syncId={syncId}
          margin={sparkline ? chartSparklineMargin : chartFullMargin}
        >
          {!sparkline && <CartesianGrid {...chartGridProps(c)} />}
          <XAxis
            dataKey="date"
            tickFormatter={tickFmt}
            {...(sparkline ? chartSparklineAxisProps() : chartAxisProps(c))}
          />
          <YAxis
            {...(sparkline ? chartSparklineAxisProps() : chartAxisProps(c))}
            domain={yDomain ?? ["auto", "auto"]}
          />
          <Tooltip
            formatter={(v) => [
              `${roundChartValue(Number(v), decimals)}${unit}`,
              label,
            ]}
            labelFormatter={labelFmt ? (v) => labelFmt(String(v)) : undefined}
            {...chartTooltipProps(c, motion)}
          />
          {snappedWindows.map((w, i) => {
            const color = ANNOTATION_KIND_META[w.kind].color;
            return (
              <ReferenceArea
                key={`win-${w.start}-${w.end}-${i}`}
                x1={w.start}
                x2={w.end}
                fill={color}
                fillOpacity={0.08}
                stroke={color}
                strokeOpacity={0.3}
                label={chartAnnotationLabel(w.label, color, "insideTopLeft")}
              />
            );
          })}
          {referenceValue != null && (
            <ReferenceLine
              y={referenceValue.value}
              stroke={referenceValue.color ?? chartSeries.sky}
              strokeDasharray={chartDash.reference}
              strokeWidth={1.5}
              label={
                referenceValue.label
                  ? chartAnnotationLabel(
                      referenceValue.label,
                      referenceValue.color ?? chartSeries.sky,
                      "insideTopLeft"
                    )
                  : undefined
              }
            />
          )}
          {snapped.map((a, i) => (
            <ReferenceLine
              key={`ann-${a.kind}-${a.date}-${i}`}
              x={a.date}
              stroke={ANNOTATION_KIND_META[a.kind].color}
              strokeDasharray={chartDash.annotation}
              strokeOpacity={0.85}
              label={chartAnnotationLabel(
                a.label,
                ANNOTATION_KIND_META[a.kind].color,
                "top"
              )}
            />
          ))}
          <Line
            type="monotone"
            dataKey={key}
            stroke={color}
            strokeWidth={2}
            dot={chartLineDot(c, {
              color,
              pointCount: data.length,
              // A sparkline is a shape, not a set of readings: per-point dots at
              // tile width fuse into a thicker line. Hover still gets its dot.
              enabled: showDots && !sparkline,
            })}
            activeDot={chartActiveDot(color)}
            {...chartMarkMotion(motion)}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
