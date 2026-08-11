import { speedKmh } from "./coaching/cardio";
import {
  cyclingActivityName,
  cyclingActivityPresentation,
  isCyclingActivity,
  isSameCyclingActivity,
  type CyclingActivityIdentity,
} from "./cycling-activity";
import { rideHref, type AppRoute } from "./hrefs";
import { median } from "./robust-stats";
import { trainingLogActivityHref } from "./timeline-format";
import { ZONES, type ActivityWindow } from "./training-zones";

export { cyclingActivityName, isCyclingActivity } from "./cycling-activity";
export type { CyclingActivityIdentity } from "./cycling-activity";

// The best read-first destination for one activity. Cycling sessions have a
// dedicated performance detail; every other activity keeps the Training Log entry as
// its canonical record. Shared training, Timeline, and equipment surfaces call
// this one resolver so the same ride never opens two different destinations.
export function activityDetailHref(
  activity: CyclingActivityIdentity & { id: number }
): AppRoute {
  return rideDetailHref(activity) ?? trainingLogActivityHref(activity.id);
}

// Some surfaces have a better non-cycling fallback than the Training Log (global
// search uses the activity's Timeline day so an old row is guaranteed to be
// present). Expose the ride-only decision without making those callers repeat
// the cycling classifier.
export function rideDetailHref(
  activity: CyclingActivityIdentity & { id: number }
): AppRoute | null {
  return isCyclingActivity(activity) ? rideHref(activity.id) : null;
}

export function wattsPerKg(
  watts: number | null | undefined,
  weightKg: number | null | undefined
): number | null {
  if (watts == null || watts <= 0 || weightKg == null || weightKg <= 0)
    return null;
  return Math.round((watts / weightKg) * 100) / 100;
}

export interface RideZoneRow {
  id: number;
  name: string;
  label: string;
  minutes: number;
  percent: number;
}

export type RideHighlight =
  | {
      key: "heart_rate_zone";
      zone: RideZoneRow;
    }
  | {
      key: "segment_results";
      personalBestCount: number;
      leaderboardCount: number;
    }
  | {
      key: "efficiency";
      driftPercent: number;
    };

export interface RideHeartRateBucket {
  ts: string;
  bpm: number;
}

export interface RideHeartRatePoint {
  date: string;
  value: number | null;
}

export interface RideComparisonInput extends CyclingActivityIdentity {
  id: number;
  date: string;
  start_time?: string | null;
  duration_min: number | null;
  distance_km: number | null;
  avg_speed_kmh: number | null;
  avg_hr: number | null;
  avg_power_w: number | null;
  weighted_avg_power_w: number | null;
  avg_cadence: number | null;
  elevation_m: number | null;
  relative_effort: number | null;
}

export type RideComparisonMetricKey =
  | "speed"
  | "heart_rate"
  | "power"
  | "weighted_power"
  | "cadence"
  | "elevation"
  | "relative_effort";

export interface RideComparisonMetric {
  key: RideComparisonMetricKey;
  current: number;
  median: number;
  difference: number;
  points: RideProgressPoint[];
}

export interface RideProgressPoint {
  id: number;
  date: string;
  title: string;
  value: number;
  current: boolean;
}

export interface RideComparison {
  basis: "distance" | "duration";
  tolerancePercent: number;
  rideCount: number;
  metrics: RideComparisonMetric[];
}

export interface RideHistoryInput extends CyclingActivityIdentity {
  id: number;
  date: string;
  start_time?: string | null;
  duration_min: number | null;
  distance_km: number | null;
}

export interface RideHistoryItem {
  id: number;
  date: string;
  title: string;
  duration_min: number | null;
  distance_km: number | null;
}

export interface RideHistoryNeighbors {
  before: RideHistoryItem[];
  after: RideHistoryItem[];
}

const COMPARABLE_TOLERANCE = 0.3;

function compareRideChronology(
  left: RideHistoryInput,
  right: RideHistoryInput
): number {
  return (
    left.date.localeCompare(right.date) ||
    (left.start_time ?? "").localeCompare(right.start_time ?? "") ||
    left.id - right.id
  );
}

// The nearest chronological cycling sessions around one ride. The stable id
// tie-break handles same-day imports without start times, while a stored start
// time takes precedence when both rides provide one.
export function rideHistoryNeighbors(
  current: RideHistoryInput,
  candidates: RideHistoryInput[],
  limit = 3
): RideHistoryNeighbors {
  const rides = candidates.filter(
    (candidate) =>
      candidate.id !== current.id && isSameCyclingActivity(current, candidate)
  );
  const toItem = (ride: RideHistoryInput): RideHistoryItem => ({
    id: ride.id,
    date: ride.date,
    title: ride.title,
    duration_min: ride.duration_min,
    distance_km: ride.distance_km,
  });
  return {
    before: rides
      .filter((candidate) => compareRideChronology(candidate, current) < 0)
      .sort((a, b) => compareRideChronology(b, a))
      .slice(0, limit)
      .map(toItem),
    after: rides
      .filter((candidate) => compareRideChronology(candidate, current) > 0)
      .sort(compareRideChronology)
      .slice(0, limit)
      .map(toItem),
  };
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function comparisonValue(
  ride: RideComparisonInput,
  key: RideComparisonMetricKey
): number | null {
  if (key === "speed") {
    return positive(
      ride.avg_speed_kmh ?? speedKmh(ride.distance_km, ride.duration_min)
    );
  }
  if (key === "heart_rate") return positive(ride.avg_hr);
  if (key === "power") return positive(ride.avg_power_w);
  if (key === "weighted_power") return positive(ride.weighted_avg_power_w);
  if (key === "cadence") return positive(ride.avg_cadence);
  if (key === "elevation") {
    return ride.elevation_m != null &&
      Number.isFinite(ride.elevation_m) &&
      ride.elevation_m >= 0
      ? ride.elevation_m
      : null;
  }
  return ride.relative_effort != null &&
    Number.isFinite(ride.relative_effort) &&
    ride.relative_effort >= 0
    ? ride.relative_effort
    : null;
}

// Compare a ride with every other similarly sized cycling session, regardless of
// when it was recorded. Distance is the stronger like-for-like boundary; duration
// is the fallback when this ride has no distance. The median resists one unusually
// hilly, stopped, or sensor-glitched ride. Every metric independently requires a
// current value and at least one peer value, so sparse imports degrade to the
// honest overlap instead of fake zeroes.
export function rideComparison(
  current: RideComparisonInput,
  candidates: RideComparisonInput[]
): RideComparison | null {
  const currentDistance = positive(current.distance_km);
  const currentDuration = positive(current.duration_min);
  const basis = currentDistance != null ? "distance" : "duration";
  const currentBasis = currentDistance ?? currentDuration;
  if (currentBasis == null) return null;

  const rides = candidates
    .filter(
      (candidate) =>
        candidate.id !== current.id && isSameCyclingActivity(current, candidate)
    )
    .filter((candidate) => {
      const candidateBasis = positive(
        basis === "distance" ? candidate.distance_km : candidate.duration_min
      );
      return (
        candidateBasis != null &&
        Math.abs(candidateBasis - currentBasis) / currentBasis <=
          COMPARABLE_TOLERANCE
      );
    });
  if (rides.length === 0) return null;

  const indoorOnly = cyclingActivityPresentation(
    cyclingActivityName(current) ?? "Cycling"
  ).indoorOnly;
  const availableKeys: RideComparisonMetricKey[] = [
    "speed",
    "heart_rate",
    "power",
    "weighted_power",
    "cadence",
    "elevation",
    "relative_effort",
  ];
  const keys = availableKeys.filter(
    (key) => !indoorOnly || key !== "elevation"
  );
  const metrics = keys.flatMap((key): RideComparisonMetric[] => {
    const currentValue = comparisonValue(current, key);
    if (currentValue == null) return [];
    const peerValues = rides
      .map((ride) => comparisonValue(ride, key))
      .filter((value): value is number => value != null);
    if (peerValues.length === 0) return [];
    const baseline = median(peerValues);
    const points = [
      ...rides.flatMap((ride): RideProgressPoint[] => {
        const value = comparisonValue(ride, key);
        return value == null
          ? []
          : [
              {
                id: ride.id,
                date: ride.date,
                title: ride.title,
                value,
                current: false,
              },
            ];
      }),
      {
        id: current.id,
        date: current.date,
        title: current.title,
        value: currentValue,
        current: true,
      },
    ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    return [
      {
        key,
        current: currentValue,
        median: baseline,
        difference: currentValue - baseline,
        points,
      },
    ];
  });
  if (metrics.length === 0) return null;
  return {
    basis,
    tolerancePercent: COMPARABLE_TOLERANCE * 100,
    rideCount: rides.length,
    metrics,
  };
}

function localMinuteIndex(stamp: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(stamp);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return Math.floor(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute)
    ) / 60_000
  );
}

function localMinuteStamp(index: number): string {
  return new Date(index * 60_000).toISOString().slice(0, 16);
}

// A true one-point-per-minute series across the ride window. Empty minutes stay
// null so the shared line chart breaks over a wear gap instead of drawing a
// fabricated interpolation. Local timestamps are treated as calendar numerals,
// never converted through the profile timezone.
export function rideHeartRateSeries(
  window: ActivityWindow | null,
  buckets: RideHeartRateBucket[]
): RideHeartRatePoint[] {
  if (!window || buckets.length === 0) return [];
  const start = localMinuteIndex(window.start);
  const end = localMinuteIndex(window.end);
  if (start == null || end == null || end <= start || end - start > 2880)
    return [];
  const byMinute = new Map(
    buckets
      .filter((bucket) => Number.isFinite(bucket.bpm))
      .map((bucket) => [bucket.ts.slice(0, 16), bucket.bpm])
  );
  return Array.from({ length: end - start }, (_, offset) => {
    const date = localMinuteStamp(start + offset);
    return { date, value: byMinute.get(date) ?? null };
  });
}

export function rideZoneRows(minutes: number[]): RideZoneRow[] {
  const total = minutes.reduce(
    (sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0),
    0
  );
  return ZONES.map((zone, index) => {
    const value =
      Number.isFinite(minutes[index]) && minutes[index] > 0
        ? minutes[index]
        : 0;
    return {
      ...zone,
      minutes: value,
      percent: total > 0 ? Math.round((value / total) * 100) : 0,
    };
  });
}

// A short, stable scan of the ride's genuinely notable context. Metric
// comparisons already sit in the summary immediately above this row. The HR
// highlight is retained because a time-dominant zone is not the same thing as
// the zone containing the ride's average HR value.
export function rideHighlights({
  zones,
  powerHrDriftPercent,
  segments,
}: {
  zones: RideZoneRow[];
  powerHrDriftPercent: number | null;
  segments: { prRank: number | null; komRank: number | null }[];
}): RideHighlight[] {
  const highlights: RideHighlight[] = [];

  const dominantZone = zones.reduce<RideZoneRow | null>(
    (best, zone) =>
      zone.minutes > 0 && (!best || zone.minutes > best.minutes) ? zone : best,
    null
  );
  if (dominantZone) {
    highlights.push({ key: "heart_rate_zone", zone: dominantZone });
  }

  const personalBestCount = segments.filter(
    (segment) => segment.prRank === 1
  ).length;
  const leaderboardCount = segments.filter(
    (segment) => segment.komRank != null && segment.komRank <= 10
  ).length;
  if (personalBestCount > 0 || leaderboardCount > 0) {
    highlights.push({
      key: "segment_results",
      personalBestCount,
      leaderboardCount,
    });
  }

  if (powerHrDriftPercent != null && Number.isFinite(powerHrDriftPercent)) {
    highlights.push({
      key: "efficiency",
      driftPercent: powerHrDriftPercent,
    });
  }
  return highlights;
}
