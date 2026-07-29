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
import {
  ChartLegend,
  chartActiveDot,
  chartAxisProps,
  chartDash,
  chartGridProps,
  chartLineDot,
  chartMarkMotion,
  chartTooltipProps,
  useChartMotion,
} from "./chart-scaffold";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { roundChartValue } from "@/lib/chart-format";
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
  annotationTooltipLabel,
  snapAnnotationsToDates,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";
import { protocolWindowEpochs } from "@/lib/chart-windows";

// Dual-series overlay for the Trends Compare tab. Plots two
// date-aligned series on one time axis so correlation is eyeball-able. Axis
// policy (issue #400): when `normalized`, both series are already min-max scaled
// to 0–1 by the caller, so they share ONE 0–100% axis; when the two series carry
// the SAME unit they also share ONE auto-scaled axis whose domain spans both, so
// the raw magnitudes stay comparable (LDL vs HDL, both mg/dL, don't get two
// contradictory scales that make the lines appear to cross); only genuinely
// DIFFERENT units get a DUAL Y-axis (A left, B right). This matches the tab copy
// ("Different units get their own axis"). Nulls (a date where only one series has
// a reading) are bridged with connectNulls. Styling matches LineChartCard.
export default function CompareChart({
  data,
  labelA,
  labelB,
  colorA,
  colorB,
  unitA,
  unitB,
  normalized,
  annotations,
  windows,
}: {
  data: { date: string; a: number | null; b: number | null }[];
  labelA: string;
  labelB: string;
  colorA: string;
  colorB: string;
  unitA: string;
  unitB: string;
  normalized: boolean;
  // Event annotations, pre-filtered to the enabled kinds by
  // the parent; drawn as vertical reference lines snapped to the nearest charted date.
  annotations?: TrendAnnotation[];
  // Protocol intervention windows (issue #660), pre-filtered to the enabled kinds;
  // drawn as shaded reference areas positioned by epoch on the time axis.
  windows?: TrendWindow[];
}) {
  const formatPrefs = useFormatPrefs();
  const c = useChartColors();
  const motion = useChartMotion();
  const snapped = annotations?.length
    ? snapAnnotationsToDates(
        annotations,
        data.map((d) => d.date)
      )
    : [];
  const windowAreas = windows?.length
    ? protocolWindowEpochs(
        windows,
        data.map((d) => d.date)
      )
    : [];
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        No overlapping data in this range
      </div>
    );
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // Same-unit series share one auto-scaled axis; only genuinely different units
  // get the second (right) axis. Units carry the caller's display suffix (e.g.
  // " mg/dL"), so compare trimmed. `normalized` always collapses to the shared
  // left axis regardless of units.
  const dualAxis = !normalized && unitA.trim() !== unitB.trim();

  // Time-scaled X axis (issue #402): the Compare tab exists so co-movement is
  // eyeball-able, but an index axis stretches clustered dates and compresses long
  // gaps — distorting the very shape it's meant to show. Map each date to an epoch
  // so both series sit at their true time position; annotations map the same way.
  const rows = data.map((d) => ({ ...d, t: dateToEpoch(d.date) }));
  const xDomain = timeAxisDomain(data.map((d) => d.date));
  const xTicks = timeAxisTicks(xDomain);
  const withYear = spansYearBoundary(xDomain);
  return (
    <div
      className="flex h-72 w-full flex-col"
      data-testid="compare-chart"
      // "dual" only for genuinely different units; same-unit (and normalized)
      // pairs share one axis (issue #400) — exposed so the e2e can assert it.
      data-axis-mode={dualAxis ? "dual" : "shared"}
      // Time-scaled (issue #402), exposed so the e2e can assert the axis is no
      // longer index-spaced.
      data-axis-scale="time"
    >
      {/* Identity for a 2-series overlay was tooltip-only (plus, in the dual-axis
          case, a colored axis tick) — i.e. color-alone, and only on hover. */}
      <ChartLegend
        items={[
          { label: labelA, color: colorA },
          { label: labelB, color: colorB },
        ]}
      />
      <ResponsiveContainer
        width="100%"
        height="100%"
        className="min-h-0 flex-1"
      >
        <LineChart
          data={rows}
          margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
        >
          <CartesianGrid {...chartGridProps(c)} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={xDomain ?? ["auto", "auto"]}
            ticks={xTicks.length ? xTicks : undefined}
            tickFormatter={(v: number) => formatTimeTick(v, withYear)}
            {...chartAxisProps(c)}
          />
          {/* Axis ticks stay in the TEXT token even in the dual-axis case (issue
              #1445): identity belongs to the marks and the legend above, and a
              tick painted in the series color is a number wearing a data color.
              Which axis is which stays readable — left is A, right is B, and the
              legend orders them the same way. */}
          <YAxis
            yAxisId="left"
            {...chartAxisProps(c)}
            domain={normalized ? [0, 1] : ["auto", "auto"]}
            tickFormatter={normalized ? pct : undefined}
          />
          {dualAxis && (
            <YAxis
              yAxisId="right"
              orientation="right"
              {...chartAxisProps(c)}
              domain={["auto", "auto"]}
            />
          )}
          <Tooltip
            formatter={(v, name) => [
              normalized
                ? pct(Number(v))
                : `${roundChartValue(Number(v))}${name === labelA ? unitA : unitB}`,
              name,
            ]}
            labelFormatter={(value) => {
              const date = epochToISO(Number(value));
              return annotationTooltipLabel(
                formatLongDate(date, formatPrefs),
                date,
                snapped,
                windows ?? []
              );
            }}
            {...chartTooltipProps(c, motion)}
          />
          {windowAreas.map((w, i) => {
            const color = ANNOTATION_KIND_META.protocol.color;
            return (
              <ReferenceArea
                key={`win-${w.x1}-${w.x2}-${i}`}
                yAxisId="left"
                x1={w.x1}
                x2={w.x2}
                fill={color}
                fillOpacity={0.08}
                stroke={color}
                strokeOpacity={0.3}
              />
            );
          })}
          {snapped.map((a, i) => (
            <ReferenceLine
              key={`ann-${a.kind}-${a.date}-${i}`}
              yAxisId="left"
              x={dateToEpoch(a.date)}
              stroke={ANNOTATION_KIND_META[a.kind].color}
              strokeDasharray={chartDash.annotation}
              strokeOpacity={0.6}
            />
          ))}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="a"
            name={labelA}
            stroke={colorA}
            strokeWidth={2}
            dot={chartLineDot(c, { color: colorA, pointCount: rows.length })}
            activeDot={chartActiveDot(colorA)}
            {...chartMarkMotion(motion)}
            connectNulls
          />
          <Line
            yAxisId={dualAxis ? "right" : "left"}
            type="monotone"
            dataKey="b"
            name={labelB}
            stroke={colorB}
            strokeWidth={2}
            dot={chartLineDot(c, { color: colorB, pointCount: rows.length })}
            activeDot={chartActiveDot(colorB)}
            {...chartMarkMotion(motion)}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
