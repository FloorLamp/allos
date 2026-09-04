"use client";

import TimeSeriesChart from "./TimeSeriesChart";
import type { ChartLineSeries, TimeSeriesSpec } from "./chart-spec";
import { useChartColors } from "./useChartColors";
import { chartSeries } from "@/lib/chart-colors";
import {
  growthTooltipLabel,
  growthTooltipOrder,
  TRAJECTORY_KEY,
} from "@/lib/growth-format";

// One reference percentile band curve, sampled across ages.
export interface GrowthBand {
  percentile: number;
  points: { ageMonths: number; value: number }[];
}
// One plotted measurement of the profile's own trajectory.
export interface GrowthPlotPoint {
  date: string;
  ageMonths: number;
  // Fractional age (issue #405) — the continuous x used for plotting, so two
  // measurements in one calendar month stay distinct instead of collapsing.
  ageMonthsExact: number;
  value: number;
  percentile: number | null;
}

// A pediatric growth chart: WHO/CDC reference percentile bands (3…97) with the
// profile's own measurement trajectory overlaid, plotted on an age (months) x-axis
// that spans the WHO→CDC transition. The plot scales to its card; a fixed minimum
// width would overflow now that the four references render as separate grid cards.
//
// THE THIRD AXIS KIND (#4925, ruled 2026-09-03). This chart's x is age in months
// — a plain number, neither a calendar day nor an instant — so the spec's x-axis
// union carries a `numeric` arm for it. Without one this chart would have had to
// stay outside the renderer, which is the outcome the ruling declined.
export default function GrowthChart({
  bands,
  points,
  currentAgeMonths,
  minMonths,
  maxMonths,
  unit,
  valueRound = 1,
}: {
  bands: GrowthBand[];
  points: GrowthPlotPoint[];
  currentAgeMonths: number;
  minMonths: number;
  maxMonths: number;
  unit: string;
  valueRound?: number;
}) {
  const c = useChartColors();

  // Merge every band-sample age and every measurement age into one sorted axis,
  // then build a row per age with a column per band percentile plus the trajectory.
  // Bands are dense; the trajectory is sparse (nulls bridged with connectNulls).
  // Bands sample at (mostly integer) ages; the trajectory keys by its FRACTIONAL
  // age (issue #405) so several measurements in one month stay distinct rows.
  const xs = new Set<number>();
  for (const b of bands) for (const p of b.points) xs.add(p.ageMonths);
  for (const p of points) xs.add(p.ageMonthsExact);
  const ages = [...xs].sort((a, b) => a - b);

  const bandMaps = bands.map((b) => ({
    percentile: b.percentile,
    map: new Map(b.points.map((p) => [p.ageMonths, p.value])),
  }));
  const trajMap = new Map(points.map((p) => [p.ageMonthsExact, p]));

  const round = (v: number) =>
    Math.round(v * 10 ** valueRound) / 10 ** valueRound;

  type Row = Record<string, number | null>;
  const rows: Row[] = ages.map((age) => {
    const row: Row = { ageMonths: age };
    for (const bm of bandMaps) {
      const v = bm.map.get(age);
      row[`p${bm.percentile}`] = v == null ? null : round(v);
    }
    const t = trajMap.get(age);
    row[TRAJECTORY_KEY] = t ? round(t.value) : null;
    return row;
  });

  // The index of each band's OWN last non-null sample (issue #405). A trajectory
  // point past a band's reference-age range extends `ages` beyond where the band
  // curve ends, so the global last row has null band columns — anchoring every
  // end-label there made them all vanish. Anchor each label at its band's real end.
  const bandLastIndex = new Map<number, number>();
  for (const bm of bandMaps) {
    let last = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][`p${bm.percentile}`] != null) last = i;
    }
    bandLastIndex.set(bm.percentile, last);
  }

  const showYears = maxMonths > 24;
  const tickFmt = (m: number) =>
    showYears ? `${Math.round((m / 12) * 10) / 10}y` : `${Math.round(m)}m`;

  // Emphasize the median; the outer bands fade toward the extremes.
  const bandColor = (p: number) => (p === 50 ? c.axis : c.grid);
  const bandWidth = (p: number) => (p === 50 ? 1.6 : 1);

  const lines: ChartLineSeries[] = [
    // Reference percentile bands, each labelled at its own curve's end so they
    // are legible without a separate legend.
    ...bandMaps.map((bm): ChartLineSeries => ({
      key: `p${bm.percentile}`,
      color: bandColor(bm.percentile),
      strokeWidth: bandWidth(bm.percentile),
      dots: {
        policy: "curve-end-label",
        label: String(bm.percentile),
        atIndex: bandLastIndex.get(bm.percentile) ?? -1,
      },
      animate: false,
      connectNulls: true,
    })),
    // The profile's own trajectory, drawn on top.
    {
      key: TRAJECTORY_KEY,
      color: chartSeries.brand,
      strokeWidth: 2.5,
      // Solid: the fill channel means exactness alone (#2653, owner call 3), and
      // a plotted measurement is an exact one.
      dots: { policy: "exact", color: chartSeries.brand },
      activeDot: chartSeries.brand,
      animate: false,
      connectNulls: true,
    },
  ];

  const spec: TimeSeriesSpec = {
    frame: { boxClass: "h-72 min-w-0", heightClass: "h-72" },
    rows,
    x: {
      kind: "numeric",
      dataKey: "ageMonths",
      domain: [minMonths, maxMonths],
      tickFormatter: tickFmt,
      title: showYears ? "Age (years)" : "Age (months)",
    },
    y: [{ domain: ["auto", "auto"] }],
    references: [
      // Current-age marker.
      {
        mark: "now",
        x: currentAgeMonths,
        label: "now",
        color: c.axis,
      },
    ],
    lines,
    tooltip: {
      row: (v, name) => [`${v}${unit}`, growthTooltipLabel(name)],
      label: (m) => {
        const mo = Number(m);
        return showYears
          ? `Age ${Math.round((mo / 12) * 10) / 10} y`
          : `Age ${Math.round(mo)} mo`;
      },
      // This chart wants its own numeric order, not the render order the shared
      // tooltip props default to.
      order: growthTooltipOrder,
    },
  };
  return <TimeSeriesChart spec={spec} />;
}
