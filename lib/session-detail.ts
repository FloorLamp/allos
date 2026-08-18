import { formatSessionElapsed } from "./cycling-analytics";
import { speedKmh } from "./coaching/cardio";
import {
  cyclingActivityName,
  cyclingActivityPresentation,
  isCyclingActivity,
  isSameCyclingActivity,
  type CyclingActivityIdentity,
} from "./cycling-activity";
import { median } from "./robust-stats";
import { ZONE_COLORS, ZONES, type ActivityWindow } from "./training-zones";
import type { AppRoute } from "./hrefs";

export { cyclingActivityName, isCyclingActivity } from "./cycling-activity";
export type { CyclingActivityIdentity } from "./cycling-activity";

export function wattsPerKg(
  watts: number | null | undefined,
  weightKg: number | null | undefined
): number | null {
  if (watts == null || watts <= 0 || weightKg == null || weightKg <= 0)
    return null;
  return Math.round((watts / weightKg) * 100) / 100;
}

export interface SessionZoneRow {
  id: number;
  name: string;
  label: string;
  minutes: number;
  percent: number;
}

export type SessionHighlightTone = "neutral" | "positive" | "caution";

// A session's short, presentation-ready recap grammar. Domain derivations own
// what is notable; every surface owns only layout, so cycling, sport, and future
// post-workout moments cannot drift into different tile vocabularies.
export interface SessionHighlight {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: SessionHighlightTone;
  markerColor?: string;
  href?: AppRoute;
}

export interface SessionHeartRateBucket {
  ts: string;
  bpm: number;
}

export interface SessionHeartRatePoint {
  date: string;
  value: number | null;
}

export interface SessionComparisonInput {
  id: number;
  date: string;
  title: string;
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

export interface CyclingComparisonInput
  extends SessionComparisonInput, CyclingActivityIdentity {}

export type SessionComparisonMetricKey =
  | "speed"
  | "heart_rate"
  | "power"
  | "weighted_power"
  | "cadence"
  | "elevation"
  | "relative_effort";

export interface SessionComparisonMetric {
  key: SessionComparisonMetricKey;
  current: number;
  median: number;
  difference: number;
  points: SessionProgressPoint[];
}

export interface SessionProgressPoint {
  id: number;
  date: string;
  title: string;
  value: number;
  current: boolean;
}

export interface SessionComparison {
  basis: "distance" | "duration";
  tolerancePercent: number;
  sessionCount: number;
  metrics: SessionComparisonMetric[];
}

const COMPARABLE_TOLERANCE = 0.3;

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function comparisonValue(
  session: SessionComparisonInput,
  key: SessionComparisonMetricKey
): number | null {
  if (key === "speed") {
    return positive(
      session.avg_speed_kmh ??
        speedKmh(session.distance_km, session.duration_min)
    );
  }
  if (key === "heart_rate") return positive(session.avg_hr);
  if (key === "power") return positive(session.avg_power_w);
  if (key === "weighted_power") return positive(session.weighted_avg_power_w);
  if (key === "cadence") return positive(session.avg_cadence);
  if (key === "elevation") {
    return session.elevation_m != null &&
      Number.isFinite(session.elevation_m) &&
      session.elevation_m >= 0
      ? session.elevation_m
      : null;
  }
  return session.relative_effort != null &&
    Number.isFinite(session.relative_effort) &&
    session.relative_effort >= 0
    ? session.relative_effort
    : null;
}

// Compare a session with every other similarly sized peer, regardless of when it
// was recorded. Distance is the stronger like-for-like boundary; duration is the
// fallback when a session has no distance. The median resists one unusual or
// sensor-glitched session. Every metric independently requires a current value
// and at least one peer value, so sparse imports degrade to the honest overlap
// instead of fake zeroes.
/**
 * A session against its like-for-like peers: same KIND of session, within a
 * tolerance of the same distance (or duration when it recorded no distance),
 * each metric measured against the median of the peers that carry it.
 *
 * #2566 asked for this generalization by name, and nothing in the arithmetic was
 * ever about bicycles — only two things were: which candidates count as peers,
 * and that an indoor ride has no elevation worth comparing. Both are parameters
 * now, `rideComparison` below is the cycling caller, and a run or a walk gets the
 * same baseline through the same code (#3009).
 *
 * Every metric degrades on its own: a peer that recorded no heart rate simply
 * does not vote on heart rate, and a metric no peer carries is absent rather
 * than compared against a zero nobody measured.
 */
export function sessionComparison<T extends SessionComparisonInput>(
  current: T,
  candidates: T[],
  opts: {
    isPeer: (current: T, candidate: T) => boolean;
    excludeKeys?: SessionComparisonMetricKey[];
  }
): SessionComparison | null {
  const currentDistance = positive(current.distance_km);
  const currentDuration = positive(current.duration_min);
  const basis = currentDistance != null ? "distance" : "duration";
  const currentBasis = currentDistance ?? currentDuration;
  if (currentBasis == null) return null;

  const sessions = candidates
    .filter(
      (candidate) =>
        candidate.id !== current.id && opts.isPeer(current, candidate)
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
  if (sessions.length === 0) return null;

  const availableKeys: SessionComparisonMetricKey[] = [
    "speed",
    "heart_rate",
    "power",
    "weighted_power",
    "cadence",
    "elevation",
    "relative_effort",
  ];
  const keys = availableKeys.filter((key) => !opts.excludeKeys?.includes(key));
  const metrics = keys.flatMap((key): SessionComparisonMetric[] => {
    const currentValue = comparisonValue(current, key);
    if (currentValue == null) return [];
    const peerValues = sessions
      .map((session) => comparisonValue(session, key))
      .filter((value): value is number => value != null);
    if (peerValues.length === 0) return [];
    const baseline = median(peerValues);
    const points = [
      ...sessions.flatMap((session): SessionProgressPoint[] => {
        const value = comparisonValue(session, key);
        return value == null
          ? []
          : [
              {
                id: session.id,
                date: session.date,
                title: session.title,
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
    sessionCount: sessions.length,
    metrics,
  };
}

// The cycling caller: peers are the same cycling subtype, and an indoor-only ride
// has no elevation worth comparing.
export function rideComparison(
  current: CyclingComparisonInput,
  candidates: CyclingComparisonInput[]
): SessionComparison | null {
  const indoorOnly = cyclingActivityPresentation(
    cyclingActivityName(current) ?? "Cycling"
  ).indoorOnly;
  return sessionComparison(current, candidates, {
    isPeer: isSameCyclingActivity,
    excludeKeys: indoorOnly ? ["elevation"] : [],
  });
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

// A true one-point-per-minute series across the session window. Empty minutes stay
// null so the shared line chart breaks over a wear gap instead of drawing a
// fabricated interpolation. Local timestamps are treated as calendar numerals,
// never converted through the profile timezone.
export function sessionHeartRateSeries(
  window: ActivityWindow | null,
  buckets: SessionHeartRateBucket[]
): SessionHeartRatePoint[] {
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

export function sessionZoneRows(minutes: number[]): SessionZoneRow[] {
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

// Cycling's derivation into the shared highlight grammar. Metric
// comparisons already sit in the summary immediately above this row. The HR
// highlight is retained because a time-dominant zone is not the same thing as
// the zone containing the session's average HR value.
export function cyclingHighlights({
  zones,
  powerHrDriftPercent,
  segments,
}: {
  zones: SessionZoneRow[];
  powerHrDriftPercent: number | null;
  segments: { prRank: number | null; komRank: number | null }[];
}): SessionHighlight[] {
  const highlights: SessionHighlight[] = [];

  const dominantZone = zones.reduce<SessionZoneRow | null>(
    (best, zone) =>
      zone.minutes > 0 && (!best || zone.minutes > best.minutes) ? zone : best,
    null
  );
  if (dominantZone) {
    highlights.push({
      key: "heart_rate_zone",
      label: "Most time in HR zone",
      value: dominantZone.name,
      detail: `${dominantZone.minutes} min · ${dominantZone.percent}% of recorded HR`,
      tone: "neutral",
      markerColor: ZONE_COLORS[dominantZone.id - 1],
    });
  }

  const personalBestCount = segments.filter(
    (segment) => segment.prRank === 1
  ).length;
  const leaderboardCount = segments.filter(
    (segment) => segment.komRank != null && segment.komRank <= 10
  ).length;
  if (personalBestCount > 0 || leaderboardCount > 0) {
    const value =
      personalBestCount > 0
        ? `${personalBestCount} personal ${personalBestCount === 1 ? "best" : "bests"}`
        : `${leaderboardCount} leaderboard ${leaderboardCount === 1 ? "result" : "results"}`;
    const detail =
      personalBestCount > 0 && leaderboardCount > 0
        ? `${leaderboardCount} top-10 leaderboard ${leaderboardCount === 1 ? "result" : "results"}`
        : "From recorded Strava segments";
    highlights.push({
      key: "segment_results",
      label: "Best efforts",
      value,
      detail,
      tone: "positive",
    });
  }

  if (powerHrDriftPercent != null && Number.isFinite(powerHrDriftPercent)) {
    const stable = Math.abs(powerHrDriftPercent) < 2;
    const improved = powerHrDriftPercent < 0;
    highlights.push({
      key: "efficiency",
      label: "Efficiency",
      value: `${powerHrDriftPercent > 0 ? "+" : ""}${powerHrDriftPercent}% drift`,
      detail: stable
        ? "Held steady across both halves"
        : improved
          ? "Improved in the second half"
          : "Fell in the second half",
      tone: stable ? "neutral" : improved ? "positive" : "caution",
    });
  }
  return highlights;
}

// Elapsed seconds as a clock reading, or an em dash when there are none. The
// ride page carried a private copy of this and `formatSessionElapsed` already
// existed beside it in cycling-analytics; rather than move a third one here for
// the activity page's splits (#3009), this is the null-tolerant wrapper both
// surfaces call and the arithmetic stays in one place.
export function formatElapsed(seconds: number | null): string {
  return seconds == null ? "—" : formatSessionElapsed(seconds);
}
