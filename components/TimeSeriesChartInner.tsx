"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type MouseHandlerDataParam,
} from "recharts";
import { useChartColors } from "./useChartColors";
import {
  CHART_LINE_STROKE_WIDTH,
  ChartLegend,
  chartActiveDot,
  chartCurve,
  chartFullMargin,
  chartGridProps,
  chartMarkMotion,
  chartReferenceMarks,
  chartSparklineMargin,
  chartSparseLineProps,
  chartSpecDots,
  chartSpecTooltipProps,
  chartSpecXAxisProps,
  chartSpecYAxisProps,
  useChartMotion,
} from "./chart-scaffold";
import type { TimeSeriesSpec } from "./chart-spec";

// THE TIME-SERIES RENDERER (#4925).
//
// One tree for every line chart in the app, driven by a `TimeSeriesSpec`. It
// replaced five hand-built trees — the daily trend card, the biomarker detail
// chart, the two-metric compare overlay, the pediatric growth chart and the
// per-source overlay — which between them carried five copies of the same
// grid/axis/tooltip wiring, three x-axis scales spelled three ways, and a gap
// treatment only one of them could reach.
//
// A card decides what its chart MEANS: its rows, which scale its x is, its
// series and their marks, its reference marks, and how a tooltip row reads.
// Everything every line chart shares is here, once, so a decision made in the
// scaffold now arrives in all five by construction rather than by someone
// remembering to thread it.
//
// ComposedChart for all of them, where four used LineChart: the long-range
// spread band needs an Area beside the Line (#1938), and recharts' LineChart is
// this element with a narrower child list. One root, so a card that grows a band
// does not have to change which chart it is.
export default function TimeSeriesChartInner({
  spec,
}: {
  spec: TimeSeriesSpec;
}) {
  const c = useChartColors();
  const motion = useChartMotion();
  const sparkline = spec.sparkline ?? false;
  return (
    <div className={spec.frame.boxClass} {...(spec.frame.data ?? {})}>
      {spec.legend ? <ChartLegend items={[...spec.legend]} /> : null}
      <ResponsiveContainer
        width="100%"
        height="100%"
        // A legend is a sibling of the plot inside a flex column, so the plot
        // takes what is left rather than its own full height plus the legend's.
        className={spec.legend ? "min-h-0 flex-1" : undefined}
      >
        <ComposedChart
          data={spec.rows as Record<string, unknown>[]}
          syncId={spec.syncId}
          syncMethod={spec.syncMethod}
          onMouseMove={
            spec.onActiveLabelChange
              ? (state: MouseHandlerDataParam) =>
                  spec.onActiveLabelChange?.(
                    state.activeLabel == null ? null : String(state.activeLabel)
                  )
              : undefined
          }
          onMouseLeave={
            spec.onActiveLabelChange
              ? () => spec.onActiveLabelChange?.(null)
              : undefined
          }
          margin={sparkline ? chartSparklineMargin : chartFullMargin}
        >
          {!sparkline && <CartesianGrid {...chartGridProps(c)} />}
          <XAxis {...chartSpecXAxisProps(c, spec.x, sparkline)} />
          {spec.y.map((axis, i) => (
            <YAxis
              key={axis.id ?? `y${i}`}
              {...chartSpecYAxisProps(c, axis, sparkline)}
            />
          ))}
          <Tooltip {...chartSpecTooltipProps(c, motion, spec.tooltip)} />
          {chartReferenceMarks(c, spec.references ?? [], spec.y[0].id)}
          {/* The spread band, UNDER the mean line — each bucket's low–high as a
              range in the series' own colour, so noise reads as visible spread
              instead of a scribble. */}
          {(spec.areas ?? []).map((a) => (
            <Area
              key={a.key}
              dataKey={a.key}
              stroke="none"
              fill={a.color}
              fillOpacity={a.fillOpacity}
              activeDot={false}
              legendType="none"
              {...chartMarkMotion(motion)}
              connectNulls={a.connectNulls}
            />
          ))}
          {spec.lines.map((l) => (
            <Line
              key={l.key}
              {...(l.yAxisId ? { yAxisId: l.yAxisId } : {})}
              type={chartCurve}
              dataKey={l.key}
              {...(l.name ? { name: l.name } : {})}
              stroke={l.color ?? "none"}
              // A stroke across readings further apart than the series' declared
              // continuity span is mostly assertion, so it demotes to a hint and
              // the dots take the lead (#2653 state 5).
              {...(l.sparseStroke
                ? chartSparseLineProps()
                : { strokeWidth: l.strokeWidth ?? CHART_LINE_STROKE_WIDTH })}
              dot={chartSpecDots(c, l.dots)}
              activeDot={l.activeDot ? chartActiveDot(l.activeDot) : false}
              {...(l.hideFromLegend ? { legendType: "none" as const } : {})}
              {...(l.hideFromTooltip ? { tooltipType: "none" as const } : {})}
              {...(l.animate === false
                ? { isAnimationActive: false }
                : chartMarkMotion(motion))}
              connectNulls={l.connectNulls}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
