"use client";

import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import {
  chartMarkMotion,
  chartSparklineAxisProps,
  chartSparklineBarCursorProps,
  chartSparklineBarProps,
  chartSparklineMargin,
  chartTooltipProps,
  useChartMotion,
} from "./chart-scaffold";
import { chartSeries } from "@/lib/chart-colors";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { groupChartValue, roundChartValue } from "@/lib/chart-format";
import { applyDayFill, type DayFillSpec } from "@/lib/trend-sparkline";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// FORM: a per-day quantity as a sparkline (issue #1485 D).
//
// The BAR twin of `LineChartCard`'s `sparkline` variant, and deliberately nothing
// more: no grid, no axes (they still scale the series, they just stop painting
// themselves), near-zero margins, hover for the value. It exists as its own card
// because the MARK is the whole point — training volume is a per-day total that is
// genuinely zero on a rest day, and a line through those days draws a slope over
// training that never happened. `lib/trend-sparkline.ts` decides which series get
// it; `chartSparklineBarProps` (the #1445 scaffold registry) styles the mark.
//
// Same props, same data shape and the same `heightClass` contract as
// `LineChartCard` in sparkline mode, so a tile swaps one for the other on a single
// prop without reshaping anything.
export default function BarSparklineInner({
  data,
  label,
  color = chartSeries.brand,
  unit = "",
  decimals,
  heightClass = "h-20",
  groupYTicks = false,
  gapFill,
}: {
  data: { date: string; value: number | null }[];
  // Densify a DAY-GRAIN quantity to the calendar (#2258). The tile follows the
  // SERIES' declaration exactly as the full chart does — a rest day in training
  // volume is a real zero and gets an empty slot at its own calendar position,
  // instead of the next training day sliding left to touch the previous one.
  gapFill?: DayFillSpec;
  label: string;
  color?: string;
  unit?: string;
  decimals?: number;
  heightClass?: string;
  // Thousands-group the tooltip value (#1541). Volume runs to five digits, so its
  // tile passes this; the axis is hidden here, so grouping is tooltip-only.
  groupYTicks?: boolean;
}) {
  const formatPrefs = useFormatPrefs();
  const c = useChartColors();
  const motion = useChartMotion();
  const isoDates = data.length > 0 && ISO_DATE.test(data[0].date);
  const filled = applyDayFill(data, isoDates ? gapFill : null);
  const labelFmt = isoDates
    ? (v: string) => formatLongDate(v, formatPrefs)
    : undefined;

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
        <BarChart data={filled.data} margin={chartSparklineMargin}>
          <XAxis dataKey="date" {...chartSparklineAxisProps()} />
          <YAxis {...chartSparklineAxisProps()} />
          <Tooltip
            cursor={chartSparklineBarCursorProps(c)}
            // See LineChartCardInner: nulls must reach the formatter so a gap
            // day says "No data" instead of opening an empty box (#2258).
            filterNull={false}
            formatter={(v) => [
              // Number(null) is 0; a gap day must say "No data" rather than
              // print a total nobody recorded (#2258).
              v == null || !Number.isFinite(Number(v))
                ? "No data"
                : `${
                    groupYTicks
                      ? groupChartValue(Number(v), decimals)
                      : roundChartValue(Number(v), decimals)
                  }${unit}`,
              label,
            ]}
            labelFormatter={labelFmt ? (v) => labelFmt(String(v)) : undefined}
            {...chartTooltipProps(c, motion)}
          />
          <Bar
            dataKey="value"
            {...chartSparklineBarProps(color)}
            {...chartMarkMotion(motion)}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
