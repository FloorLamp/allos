"use client";

import TimeSeriesChart from "./TimeSeriesChart";
import type { ChartReference, TimeSeriesSpec } from "./chart-spec";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { roundChartValue } from "@/lib/chart-format";
import { dateToEpoch, epochToISO } from "@/lib/chart-time-axis";
import {
  annotationTooltipLabel,
  snapAnnotationsToDates,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";
import { protocolWindowEpochs } from "@/lib/chart-windows";
import { EmptyState } from "@/components/ui";

// Dual-series overlay for the Trends Compare tab. Plots two
// date-aligned series on one time axis so correlation is eyeball-able. Axis
// policy (issue #400): when `normalized`, both series are already min-max scaled
// to 0–1 by the caller, so they share ONE 0–100% axis; when the two series carry
// the SAME unit they also share ONE auto-scaled axis whose domain spans both, so
// the raw magnitudes stay comparable (LDL vs HDL, both mg/dL, don't get two
// contradictory scales that make the lines appear to cross); only genuinely
// DIFFERENT units get a DUAL Y-axis (A left, B right). This matches the tab copy
// ("Different units get their own axis"). Nulls (a date where only one series has
// a reading) are bridged with connectNulls.
//
// A spec over `TimeSeriesChart` since #4925.
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
  const xDates = data.map((d) => d.date);
  const snapped = annotations?.length
    ? snapAnnotationsToDates(annotations, xDates)
    : [];
  const windowAreas = windows?.length
    ? protocolWindowEpochs(windows, xDates)
    : [];
  if (data.length === 0) {
    return <EmptyState message="No overlapping data in this range" />;
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
  const references: ChartReference[] = [
    ...windowAreas.map((w): ChartReference => ({
      mark: "window",
      x1: w.x1,
      x2: w.x2,
      kind: "protocol",
    })),
    ...snapped.map((a): ChartReference => ({
      mark: "event",
      x: dateToEpoch(a.date),
      kind: a.kind,
    })),
  ];
  const spec: TimeSeriesSpec = {
    frame: {
      boxClass: "flex h-72 w-full flex-col",
      heightClass: "h-72",
      data: {
        "data-testid": "compare-chart",
        // "dual" only for genuinely different units; same-unit (and normalized)
        // pairs share one axis (issue #400) — exposed so the e2e can assert it.
        "data-axis-mode": dualAxis ? "dual" : "shared",
        // Time-scaled (issue #402), exposed so the e2e can assert the axis is no
        // longer index-spaced.
        "data-axis-scale": "time",
      },
    },
    // Identity for a 2-series overlay was tooltip-only (plus, in the dual-axis
    // case, a colored axis tick) — i.e. color-alone, and only on hover.
    legend: [
      { label: labelA, color: colorA },
      { label: labelB, color: colorB },
    ],
    rows,
    x: { kind: "instant", dates: xDates },
    // Axis ticks stay in the TEXT token even in the dual-axis case (issue
    // #1445): identity belongs to the marks and the legend above, and a tick
    // painted in the series color is a number wearing a data color. Which axis
    // is which stays readable — left is A, right is B, and the legend orders
    // them the same way.
    y: dualAxis
      ? [
          { id: "left", domain: ["auto", "auto"] },
          { id: "right", orientation: "right", domain: ["auto", "auto"] },
        ]
      : [
          {
            id: "left",
            domain: normalized ? [0, 1] : ["auto", "auto"],
            ...(normalized ? { tickFormatter: pct } : {}),
          },
        ],
    references,
    lines: [
      {
        key: "a",
        name: labelA,
        yAxisId: "left",
        color: colorA,
        strokeWidth: 2,
        dots: { policy: "density", color: colorA, pointCount: rows.length },
        activeDot: colorA,
        connectNulls: true,
      },
      {
        key: "b",
        name: labelB,
        yAxisId: dualAxis ? "right" : "left",
        color: colorB,
        strokeWidth: 2,
        dots: { policy: "density", color: colorB, pointCount: rows.length },
        activeDot: colorB,
        connectNulls: true,
      },
    ],
    tooltip: {
      row: (v, name) => [
        normalized
          ? pct(Number(v))
          : `${roundChartValue(Number(v))}${name === labelA ? unitA : unitB}`,
        name,
      ],
      label: (value) => {
        const date = epochToISO(Number(value));
        return annotationTooltipLabel(
          formatLongDate(date, formatPrefs),
          date,
          snapped,
          windows ?? []
        );
      },
    },
  };
  return <TimeSeriesChart spec={spec} />;
}
