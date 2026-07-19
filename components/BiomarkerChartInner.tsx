"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "./useChartColors";
import { chartBand } from "@/lib/chart-colors";
import { biomarkerAxisDomain } from "@/lib/reference-range";
import { roundChartValue } from "@/lib/chart-format";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  dateToEpoch,
  epochToISO,
  formatTimeTick,
  spansYearBoundary,
  timeAxisDomain,
  timeAxisTicks,
} from "@/lib/chart-time-axis";
import {
  ANNOTATION_KIND_META,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";
import { protocolWindowEpochs } from "@/lib/chart-windows";

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
  annotations,
  windows,
}: {
  data: ChartPoint[];
  unit?: string;
  bands: BiomarkerBands;
  // Event annotations (medication start/stop, appointments, situation changes),
  // pre-filtered to the enabled kinds by the parent. Drawn as vertical reference
  // lines on the time axis — the per-analyte chart previously had none (issue #660,
  // the "did the statin move my LDL" gap).
  annotations?: TrendAnnotation[];
  // Protocol windows targeting THIS analyte (issue #660): a shaded [start, end]
  // region so the intervention that measures this biomarker is visible on its chart.
  windows?: TrendWindow[];
}) {
  const formatPrefs = useFormatPrefs();
  const c = useChartColors();
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
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

  // Time-scaled X axis (issue #402): map each reading date to an epoch so a
  // 4-year lab gap renders four years wide, not one index step. Lab draws are the
  // sparsest, most-distorted series, so this chart leads the migration.
  const rows = data.map((d) => ({ ...d, t: dateToEpoch(d.date) }));
  const xDomain = timeAxisDomain(data.map((d) => d.date));
  const xTicks = timeAxisTicks(xDomain);
  const withYear = spansYearBoundary(xDomain);
  const dates = data.map((d) => d.date);
  const windowAreas = windows?.length
    ? protocolWindowEpochs(windows, dates)
    : [];

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
              fill={chartBand.reference}
              fillOpacity={0.1}
            />
          ) : null}

          {/* Optimal band (green) — drawn over the reference band, also extended
              to the domain edge when one-sided. */}
          {optimalLow != null || optimalHigh != null ? (
            <ReferenceArea
              y1={optimalLow ?? domain[0]}
              y2={optimalHigh ?? domain[1]}
              fill={chartBand.optimal}
              fillOpacity={0.14}
              label={{
                value: "optimal",
                fontSize: 10,
                fill: chartBand.optimal,
                position:
                  optimalHigh != null ? "insideTopRight" : "insideBottomRight",
              }}
            />
          ) : null}

          {/* Protocol intervention windows (issue #660), shaded by epoch. Drawn
              over the bands but under the value line. */}
          {windowAreas.map((w, i) => {
            const color = ANNOTATION_KIND_META.protocol.color;
            return (
              <ReferenceArea
                key={`win-${w.x1}-${w.x2}-${i}`}
                x1={w.x1}
                x2={w.x2}
                fill={color}
                fillOpacity={0.08}
                stroke={color}
                strokeOpacity={0.3}
                label={{
                  value: w.label,
                  position: "insideTopLeft",
                  fontSize: 9,
                  fill: color,
                }}
              />
            );
          })}
          {/* Event annotations (medication/appointment/situation) as vertical lines. */}
          {(annotations ?? []).map((a, i) => (
            <ReferenceLine
              key={`ann-${a.kind}-${a.date}-${i}`}
              x={dateToEpoch(a.date)}
              stroke={ANNOTATION_KIND_META[a.kind].color}
              strokeDasharray="3 3"
              strokeOpacity={0.85}
              label={{
                value: a.label,
                position: "top",
                fontSize: 9,
                fill: ANNOTATION_KIND_META[a.kind].color,
              }}
            />
          ))}
          <Tooltip
            formatter={(v, _name, item) => [
              `${(item?.payload as ChartPoint | undefined)?.bound ?? ""}${fmt(Number(v))}`,
              "Value",
            ]}
            labelFormatter={(v) =>
              formatLongDate(epochToISO(Number(v)), formatPrefs)
            }
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
