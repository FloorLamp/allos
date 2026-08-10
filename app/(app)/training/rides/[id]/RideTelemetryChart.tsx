"use client";

import { useState } from "react";
import LineChartCard from "@/components/LineChartCard";
import { chartSeries } from "@/lib/chart-colors";
import { CYCLING_METRICS } from "@/lib/cycling-metrics";
import type { RideTrace, RideTraceKey } from "@/lib/cycling-analytics";
import type { CardioMetric } from "@/lib/analyze-view";
import { rideChartSyncMethod, useRideChartLink } from "./RideChartLink";

const TRACE_COLORS: Record<RideTraceKey, string> = {
  watts: CYCLING_METRICS.power.color,
  cadence: CYCLING_METRICS.cadence.color,
  velocity_smooth: CYCLING_METRICS.speed.color,
  altitude: CYCLING_METRICS.elevation.color,
  heartrate: CYCLING_METRICS.heart_rate.color,
  grade_smooth: CYCLING_METRICS.elevation.color,
  temp: chartSeries.amber,
};

export default function RideTelemetryChart({
  traces,
  initialMetric,
}: {
  traces: RideTrace[];
  initialMetric?: CardioMetric;
}) {
  const { setActiveLabel } = useRideChartLink();
  const preferredTrace: Partial<Record<CardioMetric, RideTraceKey>> = {
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

  return (
    <div className="mt-4" data-testid="ride-telemetry">
      {traces.length > 1 ? (
        <div
          className="flex flex-wrap gap-1"
          aria-label="Ride trace"
          role="group"
        >
          {traces.map((trace) => {
            const active = trace.key === selected.key;
            return (
              <button
                key={trace.key}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedKey(trace.key)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink-950 ${
                  active
                    ? "bg-brand-600 text-white"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
              >
                {trace.shortLabel}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mt-3" data-testid="ride-telemetry-chart">
        <LineChartCard
          // gap-exempt: intra-ride telemetry on an elapsed-time axis.
          data={selected.points}
          label={selected.label}
          unit={selected.unit}
          decimals={selected.decimals}
          color={TRACE_COLORS[selected.key]}
          showDots={false}
          connectNulls={false}
          heightClass="h-64"
          tickFormatter={(value) => value.replace(/:00$/, "")}
          labelFormatter={(value) => `${value} elapsed`}
          syncId="ride-effort"
          syncMethod={rideChartSyncMethod}
          onActiveLabelChange={setActiveLabel}
        />
      </div>
    </div>
  );
}
