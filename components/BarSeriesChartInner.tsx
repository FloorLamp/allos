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
import {
  chartFullMargin,
  chartGridProps,
  chartLegendWrapperStyle,
  chartMarkMotion,
  chartReferenceMarks,
  chartSpecTooltipProps,
  chartSpecXAxisProps,
  chartSpecYAxisProps,
  chartSparklineBarProps,
  chartSparklineMargin,
  chartStackSegmentProps,
  useChartMotion,
} from "./chart-scaffold";
import type { BarSeriesSpec } from "./chart-spec";

// THE BAR RENDERER (#4925).
//
// One tree for every bar chart in the app, driven by a `BarSeriesSpec`. It
// replaced three hand-built trees — stacked composition (sleep stages, macros,
// weekly cardio), weekly HR-zone minutes, and the per-day sparkline tile — which
// between them carried three copies of the same grid/axis/tooltip wiring and
// three different opinions about where a reference line goes.
//
// What a card decides is in the SPEC: its rows, its axes, its bars and their
// stack, its reference marks, and how a tooltip row reads. What every bar chart
// shares is here, once.
export default function BarSeriesChartInner({ spec }: { spec: BarSeriesSpec }) {
  const c = useChartColors();
  const motion = useChartMotion();
  const sparkline = spec.sparkline ?? false;
  const [y] = spec.y;
  return (
    <div className={spec.frame.boxClass} {...(spec.frame.data ?? {})}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={spec.rows as Record<string, unknown>[]}
          margin={sparkline ? chartSparklineMargin : chartFullMargin}
        >
          {!sparkline && <CartesianGrid {...chartGridProps(c)} />}
          <XAxis {...chartSpecXAxisProps(c, spec.x, sparkline)} />
          <YAxis {...chartSpecYAxisProps(c, y, sparkline)} />
          <Tooltip {...chartSpecTooltipProps(c, motion, spec.tooltip)} />
          {spec.legend && <Legend wrapperStyle={chartLegendWrapperStyle} />}
          {spec.bars.map((bar) => (
            <Bar
              key={bar.key}
              dataKey={bar.key}
              {...(bar.name ? { name: bar.name } : {})}
              {...(sparkline
                ? chartSparklineBarProps(bar.color)
                : {
                    ...(bar.stackId ? { stackId: bar.stackId } : {}),
                    fill: bar.color,
                    // The 2px surface gap that keeps a stack reading as discrete
                    // quantities rather than one fused column.
                    ...chartStackSegmentProps(c),
                  })}
              {...chartMarkMotion(motion)}
            />
          ))}
          {chartReferenceMarks(c, spec.references ?? [], y.id)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
