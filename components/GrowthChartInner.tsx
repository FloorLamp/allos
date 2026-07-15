"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { chartSeries } from "@/lib/chart-colors";

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
// that spans the WHO→CDC transition. Horizontally scrollable on narrow screens.
// REFERENCE CURVES — NOT MEDICAL ADVICE (disclaimer rendered by the caller card).
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
  const data: Row[] = ages.map((age) => {
    const row: Row = { ageMonths: age };
    for (const bm of bandMaps) {
      const v = bm.map.get(age);
      row[`p${bm.percentile}`] = v == null ? null : round(v);
    }
    const t = trajMap.get(age);
    row.traj = t ? round(t.value) : null;
    return row;
  });

  // The index of each band's OWN last non-null sample (issue #405). A trajectory
  // point past a band's reference-age range extends `ages` beyond where the band
  // curve ends, so the global last row has null band columns — anchoring every
  // end-label there made them all vanish. Anchor each label at its band's real end.
  const bandLastIndex = new Map<number, number>();
  for (const bm of bandMaps) {
    let last = -1;
    for (let i = 0; i < data.length; i++) {
      if (data[i][`p${bm.percentile}`] != null) last = i;
    }
    bandLastIndex.set(bm.percentile, last);
  }

  const showYears = maxMonths > 24;
  const tickFmt = (m: number) =>
    showYears ? `${Math.round((m / 12) * 10) / 10}y` : `${Math.round(m)}m`;
  const axisLabel = showYears ? "Age (years)" : "Age (months)";

  // Emphasize the median; the outer bands fade toward the extremes.
  const bandColor = (p: number) => (p === 50 ? c.axis : c.grid);
  const bandWidth = (p: number) => (p === 50 ? 1.6 : 1);

  // Right-edge percentile label, drawn only at the final (max-age) sample of each
  // band so the curves are legible without a separate legend. Returns a named
  // render fn (recharts calls it per-dot) so the label sits at the curve's end.
  function endLabel(percentile: number) {
    const render = (props: { cx?: number; cy?: number; index?: number }) => {
      const { cx, cy, index } = props;
      const key = `lbl-${percentile}`;
      if (cx == null || cy == null || index !== bandLastIndex.get(percentile))
        return <g key={key} />;
      return (
        <text
          key={key}
          x={cx + 3}
          y={cy}
          dy={3}
          fontSize={9}
          fill={c.tick}
          textAnchor="start"
        >
          {percentile}
        </text>
      );
    };
    render.displayName = `BandEndLabel${percentile}`;
    return render;
  }

  return (
    <div className="overflow-x-auto">
      <div className="h-72 min-w-[520px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 10, right: 26, bottom: 4, left: -8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
            <XAxis
              dataKey="ageMonths"
              type="number"
              domain={[minMonths, maxMonths]}
              tickFormatter={tickFmt}
              tick={{ fontSize: 11, fill: c.tick }}
              stroke={c.axis}
              label={{
                value: axisLabel,
                position: "insideBottom",
                offset: -2,
                fontSize: 10,
                fill: c.tick,
              }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: c.tick }}
              stroke={c.axis}
              domain={["auto", "auto"]}
            />
            <Tooltip
              formatter={(v, name) => {
                if (name === "traj") return [`${v}${unit}`, "This profile"];
                return [
                  `${v}${unit}`,
                  `${String(name).replace("p", "")}th pct`,
                ];
              }}
              labelFormatter={(m) => {
                const mo = Number(m);
                return showYears
                  ? `Age ${Math.round((mo / 12) * 10) / 10} y`
                  : `Age ${Math.round(mo)} mo`;
              }}
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

            {/* Current-age marker. */}
            <ReferenceLine
              x={currentAgeMonths}
              stroke={c.axis}
              strokeDasharray="4 4"
              label={{
                value: "now",
                position: "top",
                fontSize: 9,
                fill: c.tick,
              }}
            />

            {/* Reference percentile bands. */}
            {bandMaps.map((bm) => (
              <Line
                key={`band-${bm.percentile}`}
                type="monotone"
                dataKey={`p${bm.percentile}`}
                stroke={bandColor(bm.percentile)}
                strokeWidth={bandWidth(bm.percentile)}
                dot={endLabel(bm.percentile)}
                activeDot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}

            {/* The profile's own trajectory, drawn on top. */}
            <Line
              type="monotone"
              dataKey="traj"
              stroke={chartSeries.brand}
              strokeWidth={2.5}
              dot={{ r: 3, fill: chartSeries.brand, stroke: chartSeries.brand }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
