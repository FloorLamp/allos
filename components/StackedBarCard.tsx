"use client";

import BarSeriesChart from "./BarSeriesChart";
import type { BarSeriesSpec } from "./chart-spec";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { roundChartValue } from "@/lib/chart-format";
import { applyDayFillRows, type DayFillSpec } from "@/lib/trend-sparkline";
import { EmptyState } from "@/components/ui";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StackedSeries {
  key: string;
  label: string;
  color: string;
}

// A stacked bar chart over a date axis. Each datum is { date, [key]: number, ... }.
// Used for sleep-stage composition, nutrition macros, and weekly cardio volume.
//
// A SPEC over `BarSeriesChart` since #4925: this file decides what the chart
// means — which stack, which words, which day is missing — and the renderer draws
// it. Nothing here imports recharts, which is what keeps the chart chunk out of a
// page that never renders one.
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
  // decimals, matching LineChartCard. The full-precision value stays the bar's
  // domain input; only the tooltip text is rounded.
  decimals?: number;
}) {
  const formatPrefs = useFormatPrefs();
  // For ISO-date series, compact the axis to MM-DD and show a friendly long date
  // in the tooltip (matching LineChartCard). Callers passing pre-shortened MM-DD
  // dates are unaffected.
  const isoDates = data.length > 0 && ISO_DATE.test(String(data[0].date));
  const rows = applyDayFillRows(
    data as ({ date: string } & Record<string, unknown>)[],
    isoDates ? gapFill : null,
    series.map((s) => s.key)
  );
  if (data.length === 0) {
    return <EmptyState message="No data yet" />;
  }
  const spec: BarSeriesSpec = {
    frame: { boxClass: "h-64 min-w-0 max-w-full", heightClass: "h-64" },
    rows,
    // A CATEGORY of dates, not the day tick policy: the same component plots
    // week-grain and per-event stacks, whose x is not a calendar day.
    x: {
      kind: "category",
      dataKey: "date",
      tickFormatter: isoDates ? (v) => String(v).slice(5) : undefined,
    },
    y: [{ unit }],
    legend: true,
    bars: series.map((s) => ({
      key: s.key,
      name: s.label,
      color: s.color,
      stackId: "stack",
    })),
    tooltip: {
      // Nulls reach the formatter (#2258) so a gap day names its absence. A blank
      // day is blank under EVERY stacked key, so only the first entry speaks and
      // the rest are dropped — four "No data" rows would be four ways of saying
      // one thing.
      filterNull: false,
      cursor: "bar",
      row: (v, name, _payload, index) => {
        // A filled gap day carries null under every stacked key, and Number(null)
        // is 0 — printing "0 g" there would assert the very fact the null fill
        // exists to avoid (#2258). A zero-FILLED series still prints its real 0.
        if (v == null || !Number.isFinite(Number(v))) {
          // Nameless, so the row renders as the bare phrase.
          return index === 0 ? ["No data", undefined] : null;
        }
        return [`${roundChartValue(Number(v), decimals)}${unit}`, name];
      },
      label: isoDates
        ? (v) => `${labelPrefix}${formatLongDate(v, formatPrefs)}`
        : undefined,
    },
  };
  return <BarSeriesChart spec={spec} />;
}
