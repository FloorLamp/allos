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
  chartActiveDot,
  chartAnnotationLabel,
  chartAxisProps,
  chartCurve,
  chartDash,
  chartExactDot,
  chartGridProps,
  chartInexactDot,
  chartMarkMotion,
  chartTooltipProps,
  useChartMotion,
} from "./chart-scaffold";
import { chartBand } from "@/lib/chart-colors";
import { biomarkerAxisDomain } from "@/lib/reference-range";
import { roundChartValue } from "@/lib/chart-format";
import { loneReading } from "@/lib/trend-sparkline";
import SingleReadingMark from "./SingleReadingMark";
import { formatDateWithYear, formatLongDate } from "@/lib/format-date";
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
  annotationTooltipLabel,
  snapAnnotationsToDates,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";
import { protocolWindowEpochs } from "@/lib/chart-windows";
import { EmptyState } from "@/components/ui";

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
  const motion = useChartMotion();
  if (data.length === 0) {
    return <EmptyState message="No numeric readings to chart yet" />;
  }

  // ONE READING IS A MARK, NOT A PLOT (docs/internals/charts.md, #1485 G / #2615).
  //
  // The convergence that rule describes reached the tiles and the LineChartCard
  // family and stopped there: this chart went on drawing the exact render charts.md
  // names as "reads as a rendering failure" — a full-height band, empty apart from
  // one dot, under an axis that subdivided a sub-day span into "07-09 · 07-09 ·
  // 07-09 · 07-10 · 07-10 · 07-11". A tile and the detail page it taps through to
  // were drawing the identical situation two ways, which is the one thing the shared
  // predicate exists to prevent, so this family joins over the SAME `loneReading`
  // and the SAME `SingleReadingMark` rather than growing a variant of either.
  //
  // Ahead of the domain build on purpose: the mark returns before any axis exists,
  // so the repeated day ticks cannot be drawn behind it (`timeAxisTicks` also stops
  // emitting duplicate labels, for the genuine two-point sub-day span this branch
  // does not cover).
  //
  // THE CAPTION carries the YEAR, where the funnel's says "Jul 13". A lab series is
  // the sparsest one this app draws — a single reading here is regularly years old,
  // and the chart's own axis already switches to a year-bearing tick for that
  // reason. charts.md pins the caption's SHAPE ("Single reading · <when>") and
  // leaves the words per surface; the date still renders through the display
  // boundary (copy.md §9), never as stored.
  const lone = loneReading(data);
  if (lone) {
    return (
      <div className="h-64 w-full">
        <SingleReadingMark
          fill
          color={c.line}
          testid="chart-single-reading"
          readingScope="inside"
          caption={
            <>
              Single reading ·{" "}
              <time dateTime={lone.date}>
                {formatDateWithYear(lone.date, formatPrefs)}
              </time>
            </>
          }
        />
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
  const tooltipAnnotations = annotations?.length
    ? snapAnnotationsToDates(annotations, dates)
    : [];
  const windowAreas = windows?.length
    ? protocolWindowEpochs(windows, dates)
    : [];

  // THE FILL CHANNEL (#2653, owner call 3). Hollow for a bounded reading
  // ("<0.10"), solid for an exact one — and both marks now come from the
  // scaffold, which owns that vocabulary app-wide, rather than being spelled out
  // here where only this chart could see it.
  const renderDot = (props: {
    cx?: number;
    cy?: number;
    index?: number;
    payload?: ChartPoint;
  }) => {
    const { cx, cy, index, payload } = props;
    const key = `dot-${payload?.date ?? ""}-${index ?? 0}`;
    if (cx == null || cy == null) return <g key={key} />;
    const mark = payload?.bound
      ? chartInexactDot(c, c.line)
      : chartExactDot(c, c.line);
    return (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={mark.r}
        fill={mark.fill}
        stroke={mark.stroke}
        strokeWidth={mark.strokeWidth}
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
          <YAxis
            {...chartAxisProps(c)}
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
              label={chartAnnotationLabel(
                "optimal",
                chartBand.optimal,
                optimalHigh != null ? "insideTopRight" : "insideBottomRight"
              )}
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
              />
            );
          })}
          {/* Event annotations (medication/appointment/situation) as vertical lines. */}
          {(annotations ?? []).map((a, i) => (
            <ReferenceLine
              key={`ann-${a.kind}-${a.date}-${i}`}
              x={dateToEpoch(a.date)}
              stroke={ANNOTATION_KIND_META[a.kind].color}
              strokeDasharray={chartDash.annotation}
              strokeOpacity={0.6}
            />
          ))}
          <Tooltip
            formatter={(v, _name, item) => [
              `${(item?.payload as ChartPoint | undefined)?.bound ?? ""}${fmt(Number(v))}`,
              "Value",
            ]}
            labelFormatter={(value) => {
              const date = epochToISO(Number(value));
              return annotationTooltipLabel(
                formatLongDate(date, formatPrefs),
                date,
                tooltipAnnotations,
                windows ?? []
              );
            }}
            {...chartTooltipProps(c, motion)}
          />
          <Line
            type={chartCurve}
            dataKey="value"
            stroke={c.line}
            strokeWidth={2}
            dot={renderDot}
            activeDot={chartActiveDot(c.line)}
            {...chartMarkMotion(motion)}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
