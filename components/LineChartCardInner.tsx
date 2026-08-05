"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
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
import { chartBand, chartSeries } from "@/lib/chart-colors";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { groupChartValue, roundChartValue } from "@/lib/chart-format";
import {
  ANNOTATION_KIND_META,
  annotationTooltipLabel,
  snapAnnotationsToDates,
  snapWindowsToDates,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";
import {
  aggregateLongRange,
  longRangeBucketLabel,
  longRangeCaption,
} from "@/lib/long-range-series";

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
  connectNulls = true,
  tickFormatter,
  labelFormatter,
  heightClass = "h-64",
  annotations,
  windows,
  referenceValue,
  referenceBand,
  decimals,
  yDomain,
  groupYTicks = false,
  syncId,
  sparkline = false,
  sparklineDots = false,
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
  //
  // Either bound may be the string "auto" (#1541): a COUNT metric pins the FLOOR at
  // zero — a count's distance from zero is its signal, and recharts' auto floor
  // turned a 1.6× steps spread into a near-zero-to-peak swing — while leaving the
  // ceiling to follow the data.
  yDomain?: [number | "auto", number | "auto"];
  // Thousands-group the Y-axis ticks AND the tooltip value (#1541). Opt-in, because
  // grouping only earns its comma on a metric that runs to four+ digits; the two
  // travel together so the axis and the tooltip can't render one number two ways.
  groupYTicks?: boolean;
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
  // Whether a null hole is bridged by the line. Default true (a daily series with
  // an occasional missing day reads better joined). The Vitals tab's 1D charts
  // (#1466) pass FALSE: their series is a full-day 5-minute slot grid where the
  // nulls are real wear gaps / the space between two readings, and bridging them
  // would draw a straight line that reads as a measured flat HR — the same reason
  // lib/intraday.ts splits its band into segments at a gap.
  connectNulls?: boolean;
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
  // Show resting points in sparkline mode. The shared density limit still removes
  // them when they would fuse into a heavy line.
  sparklineDots?: boolean;
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
  // A horizontal target BAND — a low–high range in this chart's unit, drawn as a
  // tinted ReferenceArea behind the series (#1632: a wellness practice's weekly
  // min–max cadence). A band and a line answer different questions — "stay inside
  // this" vs "reach this" — so a caller passes whichever its target actually has,
  // and a range target passes the band rather than two lines the reader has to
  // mentally join. Same tint treatment as the biomarker reference band: fill only,
  // with the label carried by the caller's chart note.
  referenceBand?: { low: number; high: number; color?: string } | null;
}) {
  const formatPrefs = useFormatPrefs();
  const key = dataKey ?? "value";
  const c = useChartColors();
  const motion = useChartMotion();
  // For ISO-date series, default to a compact MM-DD axis and a friendly long
  // date in the tooltip (matching the journal charts). Callers passing their own
  // formatters, or non-date x-values (e.g. HH:MM intraday), are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(data[0].date);
  // Long-range aggregation (#1938): a dense daily series over a long window (the
  // 1Y pill, All time) plots as calendar-bucket means with a low–high band — the
  // ONE shared decision + computation in lib/long-range-series, applied here in
  // the one funnel every windowed line chart renders through, so no surface can
  // bucket the same series differently. Null (the common case — every span ≤180d,
  // every sparse series) keeps the raw plot byte-for-byte.
  const longRange =
    isoDates && key === "value"
      ? aggregateLongRange(
          (data as { date: string; value: number | null }[]).map((d) => ({
            date: d.date,
            value: d.value,
          }))
        )
      : null;
  const plotData: { date: string; value: number | null; band?: [number, number] }[] =
    longRange
      ? longRange.points.map((p) => ({
          date: p.date,
          value: p.value,
          band: [p.lo, p.hi] as [number, number],
        }))
      : (data as { date: string; value: number | null }[]);
  const tickFmt =
    tickFormatter ??
    (isoDates
      ? longRange?.grain === "month"
        ? // Month buckets: a MM-DD tick would read "02-01" for February — the
          // year-month is the honest tick at that grain.
          (v: string) => v.slice(0, 7)
        : (v: string) => v.slice(5)
      : undefined);
  const labelFmt =
    labelFormatter ??
    (isoDates ? (v: string) => formatLongDate(v, formatPrefs) : undefined);
  // Snap annotation markers onto charted dates so their vertical ReferenceLines
  // land on the category axis (recharts otherwise drops an off-point x). Charted =
  // PLOTTED: an aggregated chart snaps them onto its bucket starts.
  const snapped = annotations?.length
    ? snapAnnotationsToDates(
        annotations,
        plotData.map((d) => d.date)
      )
    : [];
  const snappedWindows = windows?.length
    ? snapWindowsToDates(
        windows,
        plotData.map((d) => d.date)
      )
    : [];
  const tooltipLabel = (value: string) => {
    const date = String(value);
    let formatted = labelFmt ? labelFmt(date) : date;
    // An aggregated point is a bucket, and its tooltip must say so — "Week of
    // Sunday, June 28" / "February 2026", never a bare day that implies a reading.
    if (longRange) {
      formatted = longRangeBucketLabel(longRange.grain, date, formatted);
    }
    return annotationTooltipLabel(formatted, date, snapped, snappedWindows);
  };
  if (data.length === 0) {
    return (
      <div
        className={`flex ${heightClass} items-center justify-center text-sm text-slate-500 dark:text-slate-400`}
      >
        No data yet
      </div>
    );
  }
  // The value formatter the tooltip shares between the mean line and (aggregated
  // charts only) the band's low–high pair — one number shape per chart.
  const fmtValue = (n: number) =>
    groupYTicks ? groupChartValue(n, decimals) : roundChartValue(n, decimals);
  const chart = (
    <div className={`${heightClass} min-w-0 max-w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={plotData}
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
            tickFormatter={
              groupYTicks
                ? (v) => groupChartValue(Number(v), decimals)
                : undefined
            }
          />
          <Tooltip
            formatter={(v) => {
              // The band's [lo, hi] pair renders as one "Range" row; a lone value
              // is the series itself — labelled as an average when aggregated,
              // because a bucket mean is not a reading.
              if (Array.isArray(v)) {
                const [lo, hi] = v.map(Number);
                return [`${fmtValue(lo)}–${fmtValue(hi)}${unit}`, "Range"];
              }
              return [
                `${fmtValue(Number(v))}${unit}`,
                longRange ? `${label} (avg)` : label,
              ];
            }}
            labelFormatter={(value) => tooltipLabel(String(value))}
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
              />
            );
          })}
          {referenceBand != null && referenceBand.high > referenceBand.low && (
            <ReferenceArea
              y1={referenceBand.low}
              y2={referenceBand.high}
              fill={referenceBand.color ?? chartBand.optimal}
              fillOpacity={0.12}
              stroke={referenceBand.color ?? chartBand.optimal}
              strokeOpacity={0.25}
            />
          )}
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
              strokeOpacity={0.6}
            />
          ))}
          {/* The spread band, under the mean line — each bucket's low–high as a
              range Area in the series' own colour, so noise reads as visible
              spread instead of a scribble. */}
          {longRange && (
            <Area
              dataKey="band"
              stroke="none"
              fill={color}
              fillOpacity={0.14}
              activeDot={false}
              legendType="none"
              {...chartMarkMotion(motion)}
              connectNulls={connectNulls}
            />
          )}
          <Line
            type="monotone"
            dataKey={key}
            stroke={color}
            strokeWidth={2}
            dot={chartLineDot(c, {
              color,
              pointCount: plotData.length,
              // Tile sparklines opt into resting points; dense series still fall
              // through chartLineDot's shared clutter threshold.
              enabled: showDots && (!sparkline || sparklineDots),
            })}
            activeDot={chartActiveDot(color)}
            {...chartMarkMotion(motion)}
            connectNulls={connectNulls}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
  if (!longRange || sparkline) return chart;
  // The aggregated chart's honesty caption (#1938): each point is a summary, and
  // the plot must say so on the surface, not only in the tooltip. Sparklines skip
  // it — a tile has no room for a caption, and its numbers are the caller's.
  return (
    <div className="min-w-0 max-w-full">
      {chart}
      <p
        className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
        data-testid="chart-long-range-note"
      >
        {longRangeCaption(longRange.grain)}
      </p>
    </div>
  );
}
