"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { biomarkerAxisDomain } from "@/lib/reference-range";
import { roundChartValue } from "@/lib/chart-format";

export interface BiomarkerBands {
  refLow?: number | null;
  refHigh?: number | null;
  optimalLow?: number | null;
  optimalHigh?: number | null;
}

// Value-over-time chart for one biomarker, built on the same recharts setup as
// LineChartCard but overlaying two shaded bands: the standard reference range
// (subtle gray) and the longevity-optimal range (green). One-sided ranges (only
// a low or only a high bound) render as a single dashed ReferenceLine. The value
// line is drawn on top.
interface ChartPoint {
  date: string;
  value: number;
  // Inexact-but-bounded reading ("<0.10" / ">5"), drawn as a hollow dot.
  bound?: "<" | ">";
}

export default function BiomarkerChart({
  data,
  unit = "",
  bands,
}: {
  data: ChartPoint[];
  unit?: string;
  bands: BiomarkerBands;
}) {
  const c = useChartColors();
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
        No numeric readings to chart yet
      </div>
    );
  }

  const { refLow, refHigh, optimalLow, optimalHigh } = bands;

  // Build a Y domain that comfortably contains both the data and any band bounds
  // (default 8% padding), so the bands are always visible. Shared policy (issue
  // #311); `snapWideToIntegers` snaps wide spans to whole-number tick bounds and
  // reports `wide` for `allowDecimals`.
  const { lo, hi, wide } = biomarkerAxisDomain(
    data.map((d) => d.value),
    { refLow, refHigh, optimalLow, optimalHigh },
    { snapWideToIntegers: true }
  );
  const domain: [number, number] = [lo, hi];
  // Cap tick precision so floating-point padding never renders long decimals.
  // The tooltip shares this rounding (issue #403) so the hovered number matches
  // the axis instead of showing the raw unit-conversion float.
  const tickFmt = (v: number) => String(roundChartValue(v));

  const fmt = (v: number) => `${roundChartValue(v)}${unit ? ` ${unit}` : ""}`;

  // Hollow dot for bounded readings ("<0.10"), solid for exact ones.
  const renderDot = (props: {
    cx?: number;
    cy?: number;
    index?: number;
    payload?: ChartPoint;
  }) => {
    const { cx, cy, index, payload } = props;
    const key = `dot-${payload?.date ?? ""}-${index ?? 0}`;
    if (cx == null || cy == null) return <g key={key} />;
    const bounded = !!payload?.bound;
    return (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={3}
        fill={bounded ? c.dotHollowFill : c.line}
        stroke={c.line}
        strokeWidth={bounded ? 1.5 : 1}
      />
    );
  };

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
          />
          <YAxis
            tick={{ fontSize: 11, fill: c.tick }}
            stroke={c.axis}
            domain={domain}
            allowDecimals={!wide}
            tickFormatter={tickFmt}
          />

          {/* Reference band (gray). An open-ended range shades from its single
              bound out to the domain edge, so it reads as a band, not a line. */}
          {refLow != null || refHigh != null ? (
            <ReferenceArea
              y1={refLow ?? domain[0]}
              y2={refHigh ?? domain[1]}
              fill="#94a3b8"
              fillOpacity={0.1}
            />
          ) : null}

          {/* Optimal band (green) — drawn over the reference band, also extended
              to the domain edge when one-sided. */}
          {optimalLow != null || optimalHigh != null ? (
            <ReferenceArea
              y1={optimalLow ?? domain[0]}
              y2={optimalHigh ?? domain[1]}
              fill="#0b8f5d"
              fillOpacity={0.14}
              label={{
                value: "optimal",
                fontSize: 10,
                fill: "#0b8f5d",
                position:
                  optimalHigh != null ? "insideTopRight" : "insideBottomRight",
              }}
            />
          ) : null}

          <Tooltip
            formatter={(v, _name, item) => [
              `${(item?.payload as ChartPoint | undefined)?.bound ?? ""}${fmt(Number(v))}`,
              "Value",
            ]}
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
          <Line
            type="monotone"
            dataKey="value"
            stroke={c.line}
            strokeWidth={2}
            dot={renderDot}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
