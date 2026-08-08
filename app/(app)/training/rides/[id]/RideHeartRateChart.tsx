"use client";

import LineChartCard from "@/components/LineChartCard";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { CYCLING_METRICS } from "@/lib/cycling-metrics";
import { formatRideElapsed } from "@/lib/cycling-analytics";
import { formatClockValue, formatLongDate } from "@/lib/format-date";
import type { RideHeartRatePoint } from "@/lib/ride-detail";
import { ZONE_COLORS, type ZoneModel } from "@/lib/training-zones";
import { rideChartSyncMethod, useRideChartLink } from "./RideChartLink";

export default function RideHeartRateChart({
  data,
  rideDate,
  zoneModel,
}: {
  data: RideHeartRatePoint[];
  rideDate: string;
  zoneModel: ZoneModel | null;
}) {
  const formatPrefs = useFormatPrefs();
  const { setActiveLabel } = useRideChartLink();
  const clock = (value: string) =>
    formatClockValue(value.slice(11, 16), formatPrefs.timeFormat, value);
  const zoneDomain = zoneModel
    ? ([zoneModel.lowerBounds[0], zoneModel.maxHr] as [number, number])
    : undefined;
  const zoneTicks = zoneModel
    ? [...zoneModel.lowerBounds, zoneModel.maxHr]
    : undefined;
  const zoneBands = zoneModel
    ? ZONE_COLORS.map((color, index) => ({
        low: zoneModel.lowerBounds[index],
        high:
          index < ZONE_COLORS.length - 1
            ? zoneModel.lowerBounds[index + 1]
            : zoneModel.maxHr,
        color,
        label: `Z${index + 1}`,
      }))
    : undefined;
  const elapsedData = data.map((point, index) => ({
    ...point,
    date: formatRideElapsed(index * 60),
  }));
  const clockByElapsed = new Map(
    elapsedData.map((point, index) => [point.date, data[index].date])
  );
  return (
    <LineChartCard
      // gap-exempt: intra-ride telemetry on an elapsed-time axis.
      data={elapsedData}
      label="Heart rate"
      unit=" bpm"
      color={CYCLING_METRICS.heart_rate.color}
      showDots={false}
      connectNulls={false}
      animateTooltip={false}
      heightClass="h-64"
      referenceBands={zoneBands}
      yDomain={zoneDomain}
      yTicks={zoneTicks}
      yTickFormatter={(value) => String(Math.round(value))}
      tickFormatter={(value) => value.replace(/:00$/, "")}
      labelFormatter={(value) => {
        const stamp = clockByElapsed.get(value);
        if (!stamp) return `${value} elapsed`;
        const date = stamp.slice(0, 10);
        const time = clock(stamp);
        return date === rideDate
          ? `${time} · ${value} elapsed`
          : `${formatLongDate(date, formatPrefs)} · ${time} · ${value} elapsed`;
      }}
      syncId="ride-effort"
      syncMethod={rideChartSyncMethod}
      onActiveLabelChange={setActiveLabel}
    />
  );
}
