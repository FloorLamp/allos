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
  type MouseHandlerDataParam,
} from "recharts";
import type { ComponentProps } from "react";
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

// A full ISO date (YYYY-MM-DD) — distinguishes date series (which get the
// compact-axis + friendly-tooltip default below) from time/category x-values.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
type LineChartSyncMethod = ComponentProps<typeof LineChart>["syncMethod"];

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
  highlightDate,
  referenceValue,
  referenceBand,
  referenceBands,
  decimals,
  yDomain,
  yTicks,
  yTickFormatter,
  groupYTicks = false,
  syncId,
  syncMethod,
  onActiveLabelChange,
  sparkline = false,
  sparklineDots = false,
  animateTooltip = true,
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
  // Exact numeric tick positions and formatting for charts whose Y bands carry
  // semantic boundaries (for example personalized heart-rate zones).
  yTicks?: number[];
  yTickFormatter?: (value: number) => string;
  // Thousands-group the Y-axis ticks AND the tooltip value (#1541). Opt-in, because
  // grouping only earns its comma on a metric that runs to four+ digits; the two
  // travel together so the axis and the tooltip can't render one number two ways.
  groupYTicks?: boolean;
  // Charts with the same id share hover position/tooltip alignment (used by the
  // paired sleep + mood panels so the same date is compared in both).
  syncId?: string;
  syncMethod?: LineChartSyncMethod;
  onActiveLabelChange?: (label: string | null) => void;
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
  // Recharts animates tooltip transforms between points. A chart with labeled
  // horizontal bands can force a left/right edge flip; callers may disable that
  // transform so the tooltip snaps inside the plot instead of crossing the card.
  animateTooltip?: boolean;
  // Event annotations, pre-filtered to the enabled kinds by
  // the parent. Drawn as vertical reference lines, snapped to the nearest charted
  // date (recharts positions a category-axis ReferenceLine only on an actual point).
  annotations?: TrendAnnotation[];
  // Protocol intervention windows (issue #660), pre-filtered to the enabled kinds by
  // the parent. Drawn as a shaded ReferenceArea from start to end, snapped to the
  // charted category dates (recharts positions a category-axis area only on real
  // points).
  windows?: TrendWindow[];
  // Highlight one category on the X axis (for example, the current ride at the
  // end of a personal progression series). The marker uses the shared "now"
  // treatment rather than inventing another chart annotation style.
  highlightDate?: { date: string; label: string };
  // A horizontal target line (e.g. a goal's target value, in this chart's unit).
  referenceValue?: { value: number; label?: string; color?: string } | null;
  // A horizontal target BAND — a low–high range in this chart's unit, drawn as a
  // tinted ReferenceArea behind the series (#1632: a wellness practice's weekly
  // min–max cadence). A band and a line answer different questions — "stay inside
  // this" vs "reach this" — so a caller passes whichever its target actually has,
  // and a range target passes the band rather than two lines the reader has to
  // mentally join. Same tint treatment as the biomarker reference band: fill only,
  // with the label carried by the caller's chart note.
  referenceBand?: {
    low: number;
    high: number;
    color?: string;
    label?: string;
  } | null;
  // Several horizontal context bands drawn behind one series. Ride heart rate
  // uses this for the five canonical training zones; the singular prop above
  // remains the convenient shape for one target range.
  referenceBands?: readonly {
    low: number;
    high: number;
    color?: string;
    label?: string;
  }[];
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
  const tooltipLabel = (value: string) => {
    const date = String(value);
    const formatted = labelFmt ? labelFmt(date) : date;
    return annotationTooltipLabel(formatted, date, snapped, snappedWindows);
  };
  const horizontalBands = [
    ...(referenceBand ? [referenceBand] : []),
    ...(referenceBands ?? []),
  ];
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
          syncMethod={syncMethod}
          onMouseMove={(state: MouseHandlerDataParam) =>
            onActiveLabelChange?.(
              state.activeLabel == null ? null : String(state.activeLabel)
            )
          }
          onMouseLeave={() => onActiveLabelChange?.(null)}
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
            ticks={yTicks}
            tickFormatter={
              yTickFormatter
                ? (value) => yTickFormatter(Number(value))
                : groupYTicks
                  ? (v) => groupChartValue(Number(v), decimals)
                  : undefined
            }
          />
          <Tooltip
            formatter={(v) => [
              `${
                groupYTicks
                  ? groupChartValue(Number(v), decimals)
                  : roundChartValue(Number(v), decimals)
              }${unit}`,
              label,
            ]}
            labelFormatter={(value) => tooltipLabel(String(value))}
            {...chartTooltipProps(c, motion)}
            isAnimationActive={animateTooltip && !motion.reduced}
            wrapperStyle={animateTooltip ? undefined : { transition: "none" }}
          />
          {highlightDate ? (
            <ReferenceLine
              x={highlightDate.date}
              stroke={chartSeries.brand}
              strokeDasharray={chartDash.now}
              label={chartAnnotationLabel(
                highlightDate.label,
                chartSeries.brand,
                "top"
              )}
            />
          ) : null}
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
          {horizontalBands.map((band, index) =>
            band.high > band.low ? (
              <ReferenceArea
                key={`horizontal-band-${band.low}-${band.high}-${index}`}
                y1={band.low}
                y2={band.high}
                fill={band.color ?? chartBand.optimal}
                fillOpacity={0.12}
                stroke={band.color ?? chartBand.optimal}
                strokeOpacity={0.25}
                label={
                  band.label
                    ? chartAnnotationLabel(band.label, c.tick, "insideLeft")
                    : undefined
                }
              />
            ) : null
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
          <Line
            type="monotone"
            dataKey={key}
            stroke={color}
            strokeWidth={2}
            dot={chartLineDot(c, {
              color,
              pointCount: data.length,
              // Tile sparklines opt into resting points; dense series still fall
              // through chartLineDot's shared clutter threshold.
              enabled: showDots && (!sparkline || sparklineDots),
            })}
            activeDot={chartActiveDot(color)}
            {...chartMarkMotion(motion)}
            connectNulls={connectNulls}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
