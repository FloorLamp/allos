import { speedKmh } from "./coaching/cardio";
import { shiftDateStr } from "./date";

export interface CyclingOverviewRideInput {
  id: number;
  date: string;
  title: string;
  durationMin: number | null;
  distanceKm: number | null;
  avgSpeedKmh: number | null;
  elevationM: number | null;
  avgPowerW: number | null;
  kilojoules: number | null;
}

export interface CyclingPeriodTotals {
  rides: number;
  distanceKm: number;
  durationMin: number;
  elevationM: number;
  kilojoules: number;
}

export type CyclingRecordKey =
  "distance" | "speed" | "duration" | "elevation" | "power";

export interface CyclingRecord {
  key: CyclingRecordKey;
  rideId: number;
  date: string;
  title: string;
  value: number;
}

export interface CyclingOverviewRollup {
  totals: CyclingPeriodTotals & { averageSpeedKmh: number | null };
  recent: CyclingPeriodTotals;
  previous: CyclingPeriodTotals;
  recentDays: number;
  distanceChangePercent: number | null;
  durationChangePercent: number | null;
  records: CyclingRecord[];
}

function totals(rows: CyclingOverviewRideInput[]): CyclingPeriodTotals {
  return rows.reduce<CyclingPeriodTotals>(
    (sum, ride) => ({
      rides: sum.rides + 1,
      distanceKm: sum.distanceKm + (ride.distanceKm ?? 0),
      durationMin: sum.durationMin + (ride.durationMin ?? 0),
      elevationM: sum.elevationM + (ride.elevationM ?? 0),
      kilojoules: sum.kilojoules + (ride.kilojoules ?? 0),
    }),
    { rides: 0, distanceKm: 0, durationMin: 0, elevationM: 0, kilojoules: 0 }
  );
}

function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function record(
  rides: CyclingOverviewRideInput[],
  key: CyclingRecordKey,
  value: (ride: CyclingOverviewRideInput) => number | null
): CyclingRecord | null {
  let best: CyclingRecord | null = null;
  for (const ride of rides) {
    const candidate = value(ride);
    if (candidate == null || !Number.isFinite(candidate) || candidate <= 0)
      continue;
    if (
      !best ||
      candidate > best.value ||
      (candidate === best.value &&
        (ride.date > best.date ||
          (ride.date === best.date && ride.id > best.rideId)))
    ) {
      best = {
        key,
        rideId: ride.id,
        date: ride.date,
        title: ride.title,
        value: candidate,
      };
    }
  }
  return best;
}

// All-time cycling totals and records plus a rolling 28-day form comparison.
// The page, tests, and any future cycling widget consume this one result so the
// definition of “recent form” and record tie-breaking cannot drift by surface.
export function cyclingOverviewRollup(
  rides: CyclingOverviewRideInput[],
  todayStr: string,
  recentDays = 28
): CyclingOverviewRollup {
  const recentStart = shiftDateStr(todayStr, -(recentDays - 1));
  const previousEnd = shiftDateStr(recentStart, -1);
  const previousStart = shiftDateStr(previousEnd, -(recentDays - 1));
  const recent = totals(
    rides.filter((ride) => ride.date >= recentStart && ride.date <= todayStr)
  );
  const previous = totals(
    rides.filter(
      (ride) => ride.date >= previousStart && ride.date <= previousEnd
    )
  );
  const all = totals(rides);
  const records = [
    record(rides, "distance", (ride) => ride.distanceKm),
    record(
      rides,
      "speed",
      (ride) => ride.avgSpeedKmh ?? speedKmh(ride.distanceKm, ride.durationMin)
    ),
    record(rides, "duration", (ride) => ride.durationMin),
    record(rides, "elevation", (ride) => ride.elevationM),
    record(rides, "power", (ride) => ride.avgPowerW),
  ].filter((value): value is CyclingRecord => value != null);

  return {
    totals: {
      ...all,
      averageSpeedKmh: speedKmh(all.distanceKm, all.durationMin),
    },
    recent,
    previous,
    recentDays,
    distanceChangePercent: percentChange(
      recent.distanceKm,
      previous.distanceKm
    ),
    durationChangePercent: percentChange(
      recent.durationMin,
      previous.durationMin
    ),
    records,
  };
}
