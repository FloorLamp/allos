"use client";

import TimeSeriesChart from "./TimeSeriesChart";
import type { TimeSeriesSpec } from "./chart-spec";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { dateToEpoch, epochToISO } from "@/lib/chart-time-axis";
import { EmptyState } from "@/components/ui";

// Multi-series line chart grouped by SOURCE (issue #14): one line per provider
// reporting the same metric, so overlapping devices can be compared instead of
// silently collapsed. Colors are fixed per source (lib/metric-source-priority
// SOURCE_COLORS) — identity follows the entity, and the chart carries its own
// text-token legend (issue #1445), so identity is never color-alone.
//
// A spec over `TimeSeriesChart` since #4925; the axis, grid and tooltip surface
// it used to mirror from LineChartCard by hand are now literally the same tree.

export interface CompareSeries {
  key: string; // sourceKey ('manual', 'health-connect', 'oura', …)
  label: string; // display name for tooltip/legend
  color: string;
  data: { date: string; value: number }[];
}

export default function SourceCompareChart({
  series,
  unit = "",
  heightClass = "h-64",
  showLegend = true,
}: {
  series: CompareSeries[];
  unit?: string;
  heightClass?: string;
  showLegend?: boolean;
}) {
  const formatPrefs = useFormatPrefs();
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

  if (rows.length === 0) {
    return <EmptyState message="No data yet" />;
  }
  const spec: TimeSeriesSpec = {
    frame: {
      boxClass: `${heightClass} flex w-full flex-col`,
      heightClass,
    },
    ...(showLegend
      ? { legend: series.map((s) => ({ label: s.label, color: s.color })) }
      : {}),
    rows,
    x: { kind: "instant", dates },
    y: [{ domain: ["auto", "auto"] }],
    lines: series.map((s) => ({
      key: s.key,
      color: s.color,
      strokeWidth: 2,
      dots: { policy: "density", color: s.color, pointCount: rows.length },
      activeDot: s.color,
      connectNulls: true,
    })),
    tooltip: {
      row: (v, name) => [`${v}${unit}`, labelByKey.get(name) ?? name],
      label: (v) => formatLongDate(epochToISO(Number(v)), formatPrefs),
    },
  };
  return <TimeSeriesChart spec={spec} />;
}
