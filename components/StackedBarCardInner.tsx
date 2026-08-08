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
  chartAxisProps,
  chartBarCursorProps,
  chartGridProps,
  chartLegendWrapperStyle,
  chartMarkMotion,
  chartStackSegmentProps,
  chartTooltipProps,
  useChartMotion,
} from "./chart-scaffold";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { roundChartValue } from "@/lib/chart-format";
import { applyDayFillRows, type DayFillSpec } from "@/lib/trend-sparkline";

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
  decimals,
  gapFill,
}: {
  data: Record<string, number | string | null>[];
  series: StackedSeries[];
  unit?: string;
  // Densify a DAY-GRAIN stack to the calendar (#2258). Same contract as
  // LineChartCard's: the caller names the SERIES and the window, and the per-series
  // gap policy in lib/trend-sparkline decides whether a missing day is an empty
  // slot (null under every stacked key) or a real zero. A missing day used not to
  // be on the axis at all, so four unlogged days and four zero-carb days drew the
  // same picture. Omitted → the week-grain and per-event stacks plot unchanged.
  gapFill?: DayFillSpec;
  // Prefix for the tooltip's date label, e.g. "Week of " → "Week of June 8".
  labelPrefix?: string;
  // Display precision for the tooltip value so it reads a ROUNDED number, never a
  // raw unit conversion like "1.5333333 h" (issue #403/#1162). Omitted → cap at 2
  // decimals, matching LineChartCardInner. The full-precision value stays the bar's
  // domain input; only the tooltip text is rounded.
  decimals?: number;
}) {
  const formatPrefs = useFormatPrefs();
  const c = useChartColors();
  const motion = useChartMotion();
  // For ISO-date series, compact the axis to MM-DD and show a friendly long date
  // in the tooltip (matching LineChartCard). Callers passing pre-shortened MM-DD
  // dates are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(String(data[0].date));
  const rows = applyDayFillRows(
    data as ({ date: string } & Record<string, unknown>)[],
    isoDates ? gapFill : null,
    series.map((s) => s.key)
  );
  const tickFmt = isoDates ? (v: string) => String(v).slice(5) : undefined;
  const labelFmt = isoDates
    ? (v: string) => `${labelPrefix}${formatLongDate(String(v), formatPrefs)}`
    : undefined;
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        No data yet
      </div>
    );
  }
  return (
    <div className="h-64 min-w-0 max-w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid {...chartGridProps(c)} />
          <XAxis
            dataKey="date"
            tickFormatter={tickFmt}
            {...chartAxisProps(c)}
          />
          <YAxis {...chartAxisProps(c)} unit={unit} />
          <Tooltip
            cursor={chartBarCursorProps(c)}
            // Nulls reach the formatter (#2258) so a gap day names its absence.
            // A blank day is blank under EVERY stacked key, so only the first
            // entry speaks and the rest return null (dropped) — four "No data"
            // rows would be four ways of saying one thing.
            filterNull={false}
            formatter={(v, name, _item, index) => {
              // A filled gap day carries null under every stacked key, and
              // Number(null) is 0 — printing "0 g" there would assert the very
              // fast the null fill exists to avoid (#2258). A zero-FILLED series
              // still prints its real 0.
              if (v == null || !Number.isFinite(Number(v))) {
                // Nameless, so the row renders as the bare phrase; and only
                // once, since the day is blank under every key.
                return index === 0 ? ["No data", undefined] : null;
              }
              return [`${roundChartValue(Number(v), decimals)}${unit}`, name];
            }}
            labelFormatter={labelFmt ? (v) => labelFmt(String(v)) : undefined}
            {...chartTooltipProps(c, motion)}
          />
          <Legend wrapperStyle={chartLegendWrapperStyle} />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="stack"
              fill={s.color}
              {...chartStackSegmentProps(c)}
              {...chartMarkMotion(motion)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
