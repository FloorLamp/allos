"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { formatLongDate } from "@/lib/format-date";
import {
  dateToEpoch,
  epochToISO,
  formatTimeTick,
  spansYearBoundary,
  timeAxisDomain,
  timeAxisTicks,
} from "@/lib/chart-time-axis";

// Multi-series line chart grouped by SOURCE (issue #14): one line per provider
// reporting the same metric, so overlapping devices can be compared instead of
// silently collapsed. Colors are fixed per source (lib/metric-source-priority
// SOURCE_COLORS) — identity follows the entity, and the parent card renders a
// text-token legend, so identity is never color-alone. Mirrors LineChartCardInner
// (grid/axis theming, ISO-date axis/tooltip formatting).

export interface CompareSeries {
  key: string; // sourceKey ('manual', 'health-connect', 'oura', …)
  label: string; // display name for tooltip/legend
  color: string;
  data: { date: string; value: number }[];
}

export default function SourceCompareChartInner({
  series,
  unit = "",
  heightClass = "h-64",
}: {
  series: CompareSeries[];
  unit?: string;
  heightClass?: string;
}) {
  const c = useChartColors();
  // Pivot the per-source series onto one date axis; a source without a reading
  // on a date contributes null (its line bridges the gap via connectNulls).
  const dates = [
    ...new Set(series.flatMap((s) => s.data.map((d) => d.date))),
  ].sort();
  const lookups = series.map(
    (s) => new Map(s.data.map((d) => [d.date, d.value]))
  );
  const rows = dates.map((date) => {
    // Time-scaled X (issue #402): `t` (epoch) is the numeric axis key so an
    // irregular multi-source series sits at true time positions, not index steps.
    const row: Record<string, string | number | null> = {
      date,
      t: dateToEpoch(date),
    };
    series.forEach((s, i) => {
      row[s.key] = lookups[i].get(date) ?? null;
    });
    return row;
  });
  const labelByKey = new Map(series.map((s) => [s.key, s.label]));
  const xDomain = timeAxisDomain(dates);
  const xTicks = timeAxisTicks(xDomain);
  const withYear = spansYearBoundary(xDomain);

  if (rows.length === 0) {
    return (
      <div
        className={`flex ${heightClass} items-center justify-center text-sm text-slate-400 dark:text-slate-500`}
      >
        No data yet
      </div>
    );
  }
  return (
    <div className={`${heightClass} w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={xDomain ?? ["auto", "auto"]}
            ticks={xTicks.length ? xTicks : undefined}
            tickFormatter={(v: number) => formatTimeTick(v, withYear)}
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
          />
          <YAxis
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
            domain={["auto", "auto"]}
          />
          <Tooltip
            formatter={(v, name) => [
              `${v}${unit}`,
              labelByKey.get(String(name)) ?? name,
            ]}
            labelFormatter={(v) => formatLongDate(epochToISO(Number(v)))}
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
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              dot={{ r: 2.5, fill: s.color, stroke: s.color }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
