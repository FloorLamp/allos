"use client";

// Shared telemetry chart for the canonical activity detail page.

import { useState } from "react";
import LineChartCard from "@/components/LineChartCard";
import FilterPills from "@/components/FilterPills";
import { chartNeutral, chartSeries } from "@/lib/chart-colors";
import { CYCLING_METRICS } from "@/lib/cycling-metrics";
import type { SessionTrace, SessionTraceKey } from "@/lib/cycling-analytics";
import type { CardioMetric } from "@/lib/analyze-view";
import {
  sessionChartSyncMethod,
  useSessionChartLink,
} from "./SessionChartLink";

const TRACE_COLORS: Record<SessionTraceKey, string> = {
  watts: CYCLING_METRICS.power.color,
  cadence: CYCLING_METRICS.cadence.color,
  velocity_smooth: CYCLING_METRICS.speed.color,
  altitude: CYCLING_METRICS.elevation.color,
  heartrate: CYCLING_METRICS.heart_rate.color,
  grade_smooth: CYCLING_METRICS.elevation.color,
  temp: chartSeries.amber,
};

function hasOnlyZeroValues(trace: SessionTrace): boolean {
  const values = trace.points.flatMap((point) =>
    point.value == null ? [] : [point.value]
  );
  return values.length > 0 && values.every((value) => value === 0);
}

export default function SessionTelemetryChart({
  traces,
  initialMetric,
}: {
  traces: SessionTrace[];
  initialMetric?: CardioMetric;
}) {
  const { setActiveLabel } = useSessionChartLink();
  const preferredTrace: Partial<Record<CardioMetric, SessionTraceKey>> = {
    speed: "velocity_smooth",
    elevation: "altitude",
    heart_rate: "heartrate",
    power: "watts",
    weighted_power: "watts",
    cadence: "cadence",
  };
  const requestedKey = initialMetric
    ? preferredTrace[initialMetric]
    : undefined;
  const initialKey = traces.some((trace) => trace.key === requestedKey)
    ? requestedKey
    : traces[0]?.key;
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const selected =
    traces.find((trace) => trace.key === selectedKey) ?? traces[0];
  if (!selected) return null;
  const selectedIsZeroOnly = hasOnlyZeroValues(selected);

  return (
    <div className="mt-4" data-testid="session-telemetry">
      {traces.length > 1 ? (
        /* The same registry rule the comparison strip follows (#5002): six traces
           narrowing one chart is FilterPills, not seven equal segments whose labels
           can only wrap inside the word. Wrapped rather than scrolled, for the reason
           the comparison card states — the scrolling layout bleeds past its container
           and this one sits inside a card that asserts it does not overflow. The zero-only trace keeps the announcement
           that was actually reaching anyone — a reader still hears why a flat line
           at 0 is not missing data. */
        <FilterPills
          mode="button"
          options={traces.map((trace) => {
            const zeroOnly = hasOnlyZeroValues(trace);
            return {
              value: trace.key,
              label: trace.shortLabel,
              // THE `title` THAT WAS HERE IS GONE, AND IT WAS ALREADY GONE:
              // `SegmentedControlOption` has no `title` field, and this options array
              // is built by `.map()`, so the excess key was inferred away and never
              // reached the DOM. `lib/__tests__/raw-title-boundary.test.ts` is why the
              // control has no such field — production is kept free of hover-only
              // explanatory titles (#3375) — so restoring it here would have meant
              // widening `Chip` past that ratchet to re-add something no reader ever
              // had. The accessible label says the same thing, and does reach them.
              accessibleLabel: zeroOnly
                ? `${trace.shortLabel}, all recorded values are 0`
                : undefined,
            };
          })}
          value={selected.key}
          onSelect={setSelectedKey}
          label="Recorded metrics"
          testId="session-telemetry-metrics"
          layout="wrap"
        />
      ) : null}
      <div className="mt-3" data-testid="session-telemetry-chart">
        <LineChartCard
          // gap-exempt: intra-session telemetry on an elapsed-time axis.
          data={selected.points}
          label={selected.label}
          unit={selected.unit}
          decimals={selected.decimals}
          color={selectedIsZeroOnly ? chartNeutral : TRACE_COLORS[selected.key]}
          showDots={false}
          connectNulls={false}
          heightClass="h-64"
          tickFormatter={(value) => value.replace(/:00$/, "")}
          labelFormatter={(value) => `${value} elapsed`}
          syncId="session-effort"
          syncMethod={sessionChartSyncMethod}
          onActiveLabelChange={setActiveLabel}
        />
      </div>
    </div>
  );
}
