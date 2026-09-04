"use client";

import TimeSeriesChart from "./TimeSeriesChart";
import type { ChartReference, TimeSeriesSpec } from "./chart-spec";
import { useChartColors } from "./useChartColors";
import { chartBand } from "@/lib/chart-colors";
import { biomarkerAxisDomain } from "@/lib/reference-range";
import { roundChartValue } from "@/lib/chart-format";
import { loneReading } from "@/lib/trend-sparkline";
import SingleReadingMark from "./SingleReadingMark";
import { formatDateWithYear, formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { dateToEpoch, epochToISO } from "@/lib/chart-time-axis";
import {
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

// Value-over-time chart for one biomarker: the shared time-series tree with two
// shaded bands over it — the standard reference range (subtle gray) and the
// longevity-optimal range (green). One-sided ranges shade from their single
// bound out to the domain edge, so they read as a band and not a line.
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

  const fmt = (v: number) => `${roundChartValue(v)}${unit ? ` ${unit}` : ""}`;

  // Time-scaled X axis (issue #402): map each reading date to an epoch so a
  // 4-year lab gap renders four years wide, not one index step. Lab draws are the
  // sparsest, most-distorted series, so this chart leads the migration.
  const rows = data.map((d) => ({ ...d, t: dateToEpoch(d.date) }));
  const xDates = data.map((d) => d.date);
  const tooltipAnnotations = annotations?.length
    ? snapAnnotationsToDates(annotations, xDates)
    : [];
  const windowAreas = windows?.length
    ? protocolWindowEpochs(windows, xDates)
    : [];

  const references: ChartReference[] = [
    // Reference band (gray), extended to the domain edge when one-sided.
    ...(refLow != null || refHigh != null
      ? [
          {
            mark: "band" as const,
            y1: refLow ?? domain[0],
            y2: refHigh ?? domain[1],
            color: chartBand.reference,
            fillOpacity: 0.1,
          },
        ]
      : []),
    // Optimal band (green) — drawn over the reference band, also extended to the
    // domain edge when one-sided.
    ...(optimalLow != null || optimalHigh != null
      ? [
          {
            mark: "band" as const,
            y1: optimalLow ?? domain[0],
            y2: optimalHigh ?? domain[1],
            color: chartBand.optimal,
            fillOpacity: 0.14,
            label: "optimal",
            labelColor: chartBand.optimal,
            labelPosition:
              optimalHigh != null
                ? ("insideTopRight" as const)
                : ("insideBottomRight" as const),
          },
        ]
      : []),
    // Protocol intervention windows (issue #660), shaded by epoch. Drawn over the
    // bands but under the value line.
    ...windowAreas.map((w): ChartReference => ({
      mark: "window",
      x1: w.x1,
      x2: w.x2,
      kind: "protocol",
    })),
    // Event annotations (medication/appointment/situation) as vertical lines.
    ...(annotations ?? []).map((a): ChartReference => ({
      mark: "event",
      x: dateToEpoch(a.date),
      kind: a.kind,
    })),
  ];

  const spec: TimeSeriesSpec = {
    frame: { boxClass: "h-64 w-full", heightClass: "h-64" },
    rows,
    x: { kind: "instant", dates: xDates },
    y: [
      {
        domain,
        allowDecimals: !wide,
        // Cap tick precision so floating-point padding never renders long
        // decimals. The tooltip shares this rounding (issue #403) so the hovered
        // number matches the axis instead of showing the raw unit-conversion float.
        tickFormatter: (v) => String(roundChartValue(v)),
      },
    ],
    references,
    lines: [
      {
        key: "value",
        color: c.line,
        strokeWidth: 2,
        // THE FILL CHANNEL (#2653, owner call 3). Hollow for a bounded reading
        // ("<0.10"), solid for an exact one — at every reading, whatever the
        // density threshold says, because on a lab series the readings ARE the
        // content.
        dots: {
          policy: "bounded",
          color: c.line,
          inexact: new Set(data.flatMap((d, i) => (d.bound ? [i] : []))),
        },
        activeDot: c.line,
        connectNulls: true,
      },
    ],
    tooltip: {
      row: (v, _name, payload) => [
        `${(payload as ChartPoint | undefined)?.bound ?? ""}${fmt(Number(v))}`,
        "Value",
      ],
      label: (value) => {
        const date = epochToISO(Number(value));
        return annotationTooltipLabel(
          formatLongDate(date, formatPrefs),
          date,
          tooltipAnnotations,
          windows ?? []
        );
      },
    },
  };
  return <TimeSeriesChart spec={spec} />;
}
