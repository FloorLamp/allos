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
  chartSparseDot,
  chartSparseLineProps,
  chartTooltipProps,
  CHART_LINE_STROKE_WIDTH,
  useChartMotion,
} from "./chart-scaffold";
import { chartBand, chartSeries } from "@/lib/chart-colors";
import Link from "next/link";
import SingleReadingMark from "./SingleReadingMark";
import { formatLongDate, formatMonthDay } from "@/lib/format-date";
import { dataSectionHref } from "@/lib/hrefs";
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
import {
  applyDayFill,
  gapBreaksPastLimit,
  gapLimitDaysForSeriesKey,
  loneReading,
  overLimitHoles,
  seriesGapForSeriesKey,
  sparseSeriesCaption,
  sparseSeriesVerdict,
  trailingOutageCaption,
  unloggedGapLabel,
  type DayFillSpec,
  type SeriesHole,
} from "@/lib/trend-sparkline";

// A full ISO date (YYYY-MM-DD) — distinguishes date series (which get the
// compact-axis + friendly-tooltip default below) from time/category x-values.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Derived from ComposedChart since #1938 switched the chart element (the long-
// range band needs an Area beside the Line); recharts' sync contract is the same.
type LineChartSyncMethod = ComponentProps<typeof ComposedChart>["syncMethod"];

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
  gapFill,
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
  // Densify a DAY-GRAIN series to the calendar before plotting (#2258). The
  // surface passes WHICH series (its `metric:` key) and the window it selected;
  // the GAP POLICY — null hole vs real zero, bridged vs broken — is looked up
  // here from lib/trend-sparkline's per-series registry, so a page can never hand
  // a chart a policy of its own and no two surfaces can disagree about what a
  // missing steps day means. Omitted → no densification (a per-event or intraday
  // axis, where the index genuinely IS the x). When present it also OVERRIDES
  // `connectNulls`, because bridging is half of the declared policy.
  gapFill?: DayFillSpec;
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
  // date in the tooltip (matching the training log charts). Callers passing their own
  // formatters, or non-date x-values (e.g. HH:MM intraday), are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(data[0].date);
  // Day-grain densification (#2258), applied BEFORE aggregation so the buckets see
  // the calendar too, and below the page's own `data-points` so a readings table
  // still counts real readings (the #2029 contract). `realCount` is the reading
  // count the dot-density threshold must use — after densification `series.length`
  // is a count of DAYS, and a 90-day window holding 12 weigh-ins would silently
  // lose its dots.
  const filled = applyDayFill(
    data,
    isoDates && key === "value" ? gapFill : null
  );
  const series = filled.data;
  const bridges = filled.bridges ?? connectNulls;
  // Long-range aggregation (#1938): a dense daily series over a long window (the
  // 1Y pill, All time) plots as calendar-bucket means with a low–high band — the
  // ONE shared decision + computation in lib/long-range-series, applied here in
  // the one funnel every windowed line chart renders through, so no surface can
  // bucket the same series differently. Null (the common case — every span ≤180d,
  // every sparse series) keeps the raw plot byte-for-byte.
  const longRange =
    isoDates && key === "value"
      ? aggregateLongRange(
          series.map((d) => ({
            date: d.date,
            value: d.value,
          }))
        )
      : null;
  const plotData: {
    date: string;
    value: number | null;
    band?: [number, number];
  }[] = longRange
    ? longRange.points.map((p) => ({
        date: p.date,
        value: p.value,
        // An EMPTY calendar bucket carries no band — omitted rather than a
        // [null, null] pair, so the Area draws a hole instead of collapsing to
        // the axis floor.
        band:
          p.lo == null || p.hi == null
            ? undefined
            : ([p.lo, p.hi] as [number, number]),
      }))
    : series;
  // The DENSITY verdict (#2653 state 5). Asked of the RAW series, before
  // densification and before aggregation: a filled calendar day is not a reading,
  // and a bucket mean is not one either. Only a gapFill caller can be judged —
  // the series key is what carries the declared continuity span, and a
  // `gap-exempt:` chart's x is not a calendar day, so days between its points is
  // not a question that has an answer. An aggregated plot is dense by definition
  // (aggregation requires ≥2 readings per bucket), so the two never coincide.
  const sparse =
    isoDates && key === "value" && gapFill && !longRange
      ? sparseSeriesVerdict(gapFill.seriesKey, data)
      : null;
  // THE UNLOGGED RUNS (#2653 states 2, 3 and 4). Asked of the DENSIFIED series,
  // which is what makes a run of nulls a count of calendar days rather than a
  // count of missing rows — and only of a gapFill caller, because the series key
  // is what carries the declared limit. An aggregated plot is excluded: a bucket
  // is not a day, so "4 days unlogged" is not a sentence about one.
  const holes: SeriesHole[] =
    isoDates && key === "value" && gapFill && !longRange
      ? overLimitHoles(series, gapLimitDaysForSeriesKey(gapFill.seriesKey))
      : [];
  // Only a series that OPTED IN has its stroke cut (owner call 2). For every
  // other policy the hole is named and the stroke stays exactly as declared.
  const breaksPastLimit =
    gapFill != null &&
    holes.length > 0 &&
    gapBreaksPastLimit(seriesGapForSeriesKey(gapFill.seriesKey));
  const interiorHoles = holes.filter((h) => !h.trailing);
  const trailingHole = holes.find((h) => h.trailing) ?? null;
  // The last day that actually carries a reading — the "since" in the live
  // outage's caption. Read off the plotted series rather than recomputed, so the
  // sentence and the drawing can never name different days.
  const lastReadingDate = trailingHole
    ? (series
        .slice(0, series.findIndex((d) => d.date === trailingHole.from))
        .filter((d) => d.value != null)
        .at(-1)?.date ?? null)
    : null;
  // THE BROKEN STROKE (#2653 state 3). recharts' `connectNulls` is all-or-nothing
  // — true bridges every hole, false breaks at every one — and the declared
  // policy is neither: short holes bridge, over-limit holes do not. So the series
  // is cut into RUNS at the over-limit holes and each run is drawn as its own
  // bridged stroke, with the marks and the tooltip staying on one strokeless
  // line above them. Nothing is hidden, no point moves, and no value is invented
  // to span anything.
  const strokeRuns: number[][] = [];
  if (breaksPastLimit && interiorHoles.length > 0) {
    const cutAt = new Set<string>();
    for (const hole of interiorHoles) cutAt.add(hole.from);
    let runStart = 0;
    plotData.forEach((row, i) => {
      if (!cutAt.has(row.date)) return;
      if (i > runStart) strokeRuns.push([runStart, i - 1]);
      runStart = i;
    });
    if (runStart < plotData.length) {
      strokeRuns.push([runStart, plotData.length - 1]);
    }
  }
  const runData =
    strokeRuns.length > 1
      ? plotData.map((row, i) => {
          const out: Record<string, unknown> = { ...row };
          strokeRuns.forEach(([from, to], r) => {
            out[`run${r}`] = i >= from && i <= to ? row.value : null;
          });
          return out;
        })
      : plotData;
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
  // ONE READING IS A MARKER, NOT A PLOT (#2653 state 1).
  //
  // The Overview tiles have degraded a one-reading series to a dot-on-a-rule
  // since #1485 G, and #2671 taught the trend metric CARDS the same thing — but
  // it taught the call site, so every other consumer of this chart (sleep,
  // nutrition, longevity) kept drawing a 30-day band empty apart from one marker
  // half-clipped against the y-axis. That reads as a rendering failure rather
  // than as the true statement, and the reason it survived one fix is that the
  // decision was being made ABOVE the chart instead of inside it.
  //
  // So it moves here, into the one funnel every line chart renders through. The
  // gate is the same one the other honesty states use — a dated day-grain series
  // plotted on `value` — because a per-event or intraday x is not a calendar day
  // and "one reading on Jul 13" is not a sentence about it. A caller that has
  // already drawn its own mark never reaches this branch, so the two cannot
  // double up.
  const lone =
    isoDates && key === "value" ? loneReading(data) : null;
  if (lone && lone.value != null) {
    return (
      <div className={`${heightClass} min-w-0 max-w-full`}>
        <SingleReadingMark
          fill
          color={color}
          testid="chart-single-reading"
          readingScope="inside"
          caption={
            <>
              Single reading ·{" "}
              <time dateTime={lone.date}>
                {formatMonthDay(lone.date, formatPrefs)}
              </time>
            </>
          }
        />
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
          data={runData}
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
            // Nulls must REACH the formatter (#2258). recharts filters them out
            // by default, which is why a gap day's tooltip was an unlabelled
            // empty box: with every calendar day now on the axis, hovering an
            // outage is a thing a reader will do, and the honest answer is a
            // named absence.
            filterNull={false}
            formatter={(v, name) => {
              // The band's [lo, hi] pair renders as one "Range" row; a lone value
              // is the series itself — labelled as an average when aggregated,
              // because a bucket mean is not a reading.
              if (Array.isArray(v)) {
                const [lo, hi] = v.map(Number);
                return [`${fmtValue(lo)}–${fmtValue(hi)}${unit}`, "Range"];
              }
              // A GAP DAY (#2258). Densification puts every calendar day on the
              // axis, so hovering an outage is now possible — and it must SAY
              // so. Number(null) is 0, which is precisely the assertion the fill
              // exists to avoid ("you walked 0 steps" for a day the watch never
              // reported). A zero-FILLED day carries a real 0 and still prints it.
              if (v == null || !Number.isFinite(Number(v))) {
                // The spread band has no row of its own on an empty bucket —
                // returning null drops the item rather than printing a second
                // "No data" beside the series' own.
                return name === "band" ? null : ["No data", label];
              }
              return [
                `${fmtValue(Number(v))}${unit}`,
                longRange ? `${label} (avg)` : label,
              ];
            }}
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
          {/* THE UNLOGGED RUN, DRAWN (#2653 states 2 and 3). A hole earns a band
              the exact width of the days it covers, in the neutral grid token at
              a fraction of its weight — the absence of plot made visible, never a
              second series. The interior hole carries its own count; the live one
              at the end is the "quiet span visibly quiet" and takes its words
              from the caption below, which is where the route to the fix can be a
              real link. Static in every state: nothing here animates, so there is
              no end state to arrive at. */}
          {holes.map((hole) => (
            <ReferenceArea
              key={`hole-${hole.from}-${hole.to}`}
              x1={hole.from}
              x2={hole.to}
              fill={c.grid}
              fillOpacity={0.45}
              stroke="none"
              label={
                hole.trailing
                  ? undefined
                  : chartAnnotationLabel(
                      unloggedGapLabel(hole.days),
                      c.tick,
                      "insideTop"
                    )
              }
            />
          ))}
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
              connectNulls={bridges}
            />
          )}
          {/* THE PER-RUN STROKES (#2653 state 3). One bridged line per run of the
              series that survives its over-limit holes, so a skipped Tuesday is
              still crossed and a skipped week is not. They carry stroke only —
              the marks, the hover dot and the tooltip all stay on the single line
              below, so a reader still gets one value per day and the legend still
              sees one series. */}
          {strokeRuns.length > 1 &&
            strokeRuns.map(([from], r) => (
              <Line
                key={`run-${from}`}
                type="monotone"
                dataKey={`run${r}`}
                stroke={color}
                {...(sparse
                  ? chartSparseLineProps()
                  : { strokeWidth: CHART_LINE_STROKE_WIDTH })}
                dot={false}
                activeDot={false}
                legendType="none"
                tooltipType="none"
                {...chartMarkMotion(motion)}
                connectNulls
              />
            ))}
          <Line
            type="monotone"
            dataKey={key}
            // A cut series draws its strokes per run, above; this line keeps the
            // marks and the tooltip and paints no stroke of its own, so the two
            // cannot disagree about where a reading is.
            stroke={strokeRuns.length > 1 ? "none" : color}
            // A stroke across readings further apart than the series' declared
            // continuity span is mostly assertion, so it demotes to a hint and
            // the dots take the lead (#2653 state 5). Nothing is hidden and no
            // point moves — the same data, drawn at the confidence it earns.
            {...(sparse
              ? chartSparseLineProps()
              : { strokeWidth: CHART_LINE_STROKE_WIDTH })}
            dot={
              // A demoted line's dots lead, on a TILE as much as on a card: the
              // readings are the content, and a tile that opts out of resting
              // dots for density reasons has no density to protect here. Only
              // the caller's hard override still wins, and a series dense enough
              // to need it can never be sparse.
              sparse && showDots
                ? chartSparseDot(c, color)
                : chartLineDot(c, {
                    color,
                    // REAL readings, never calendar days (#2258 §5): the
                    // densified array is a day count, and comparing it against
                    // the density threshold would drop the dots from a
                    // sparse-but-short series. An aggregated plot counts its
                    // OCCUPIED buckets for the same reason.
                    pointCount: longRange
                      ? longRange.points.filter((p) => p.value != null).length
                      : filled.realCount,
                    // Tile sparklines opt into resting points; dense series still
                    // fall through chartLineDot's shared clutter threshold.
                    enabled: showDots && (!sparkline || sparklineDots),
                  })
            }
            activeDot={chartActiveDot(color)}
            {...chartMarkMotion(motion)}
            connectNulls={bridges}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
  // Every caption here is an honesty note ABOUT THE MARK, and a sparkline takes
  // none of them: a tile has no room for a sentence, and its numbers are the
  // caller's.
  if (sparkline || (!longRange && !sparse && !trailingHole)) return chart;
  return (
    <div className="min-w-0 max-w-full">
      {chart}
      {/* The aggregated chart's honesty caption (#1938): each point is a summary,
          and the plot must say so on the surface, not only in the tooltip. */}
      {longRange && (
        <p
          className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
          data-testid="chart-long-range-note"
        >
          {longRangeCaption(longRange.grain)}
        </p>
      )}
      {/* The demoted plot's count (#2653 state 5). Same slot, same neutral text
          token, no chip and no colour — it lets a reader price the stroke, and a
          badge would make the chart look more considered instead of less
          certain. */}
      {sparse && (
        <p
          className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
          data-testid="chart-sparse-note"
        >
          {sparseSeriesCaption(sparse)}
        </p>
      )}
      {/* THE LIVE OUTAGE, NAMED (#2653 state 4). The chart already drew the hole;
          this says when it started and routes to where the diagnosis lives. It is
          deliberately NOT a verdict — #2146's quiet-stream judgement stays on
          Data → Review, and this annotation only explains a gap the reader can
          already see and offers the one door that leads somewhere about it. */}
      {trailingHole && lastReadingDate && (
        <p
          className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
          data-testid="chart-trailing-outage-note"
        >
          {trailingOutageCaption(formatMonthDay(lastReadingDate, formatPrefs))}{" "}
          ·{" "}
          <Link
            href={dataSectionHref("review")}
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
            data-testid="chart-trailing-outage-link"
          >
            Data → Review
          </Link>
        </p>
      )}
    </div>
  );
}
