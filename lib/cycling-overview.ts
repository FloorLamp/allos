import { shiftDateStr } from "./date";
import {
  sessionOverviewRollup,
  type SessionOverviewRecordKey,
  type SessionPeriodTotals,
} from "./session-overview";

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

export interface CyclingPeriodExtras {
  elevationM: number;
  kilojoules: number;
}

export type CyclingRecordKey = SessionOverviewRecordKey | "elevation" | "power";

export interface CyclingRecord {
  key: CyclingRecordKey;
  activityId: number;
  date: string;
  title: string;
  value: number;
}

export interface CyclingOverviewRollup {
  totals: SessionPeriodTotals &
    CyclingPeriodExtras & { averageSpeedKmh: number | null };
  recent: SessionPeriodTotals & CyclingPeriodExtras;
  previous: SessionPeriodTotals & CyclingPeriodExtras;
  recentDays: number;
  distanceChangePercent: number | null;
  durationChangePercent: number | null;
  records: CyclingRecord[];
}

function extras(
  rows: readonly CyclingOverviewRideInput[]
): CyclingPeriodExtras {
  return rows.reduce<CyclingPeriodExtras>(
    (sum, ride) => ({
      elevationM: sum.elevationM + (ride.elevationM ?? 0),
      kilojoules: sum.kilojoules + (ride.kilojoules ?? 0),
    }),
    { elevationM: 0, kilojoules: 0 }
  );
}

function record(
  rides: readonly CyclingOverviewRideInput[],
  key: "elevation" | "power",
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
          (ride.date === best.date && ride.id > best.activityId)))
    ) {
      best = {
        key,
        activityId: ride.id,
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
  const shared = sessionOverviewRollup(rides, todayStr, recentDays);
  const recentStart = shiftDateStr(todayStr, -(recentDays - 1));
  const previousEnd = shiftDateStr(recentStart, -1);
  const previousStart = shiftDateStr(previousEnd, -(recentDays - 1));
  const recentRides = rides.filter(
    (ride) => ride.date >= recentStart && ride.date <= todayStr
  );
  const previousRides = rides.filter(
    (ride) => ride.date >= previousStart && ride.date <= previousEnd
  );
  const records = [
    ...shared.records,
    record(rides, "elevation", (ride) => ride.elevationM),
    record(rides, "power", (ride) => ride.avgPowerW),
  ].filter((value): value is CyclingRecord => value != null);

  return {
    totals: {
      ...shared.totals,
      ...extras(rides),
    },
    recent: { ...shared.recent, ...extras(recentRides) },
    previous: { ...shared.previous, ...extras(previousRides) },
    recentDays,
    distanceChangePercent: shared.distanceChangePercent,
    durationChangePercent: shared.durationChangePercent,
    records,
  };
}
