import type { ActivityEditData } from "../../activity-form-model";
import { pickImportedActivityMetrics } from "../../activity-import-details";
import {
  activityCalorieDisplay,
  type ActivityCalorieDisplay,
} from "../../calorie-estimate";
import { bodyweightAsOf } from "../../bodyweight";
import {
  cyclingLoad,
  distanceSplits,
  parseCyclingStreams,
  powerCurve,
  powerCurveLabel,
  powerZoneTimes,
  rideDynamics,
  rideTimedRoutePoints,
  rideTraces,
  routeFingerprint,
  type CyclingLoad,
  type PowerCurvePoint,
  type PowerZoneRange,
  type PowerZoneTime,
  type RideDistanceSplit,
  type RideDynamics,
  type RideTrace,
  type RideTimedRoutePoint,
} from "../../cycling-analytics";
import {
  parseCyclingStreamSummary,
  parsePowerZones,
} from "../../cycling-stream-summary";
import { speedKmh } from "../../coaching/cardio";
import {
  cyclingOverviewRollup,
  type CyclingOverviewRollup,
} from "../../cycling-overview";
import {
  cyclingDistribution,
  type CyclingDistribution,
} from "../../cycling-distribution";
import { shiftDateStr } from "../../date";
import { db, readTx, today } from "../../db";
import { getEquipmentById } from "../../equipment";
import { activityHistoryKey } from "../../activities-catalog";
import {
  cyclingActivityName,
  cyclingActivityPresentation,
} from "../../cycling-activity";
import {
  isCyclingActivity,
  rideComparison,
  rideHistoryNeighbors,
  type RideComparison,
  type RideHistoryNeighbors,
} from "../../ride-detail";
import {
  activityWindows,
  scopeBucketsToWindows,
  zoneForBpm,
  zoneMinuteTotals,
  zoneWindowSince,
  ZONE_WINDOW_WEEKS,
  type ActivityWindow,
  type ZoneModel,
} from "../../training-zones";
import type { Activity, Equipment } from "../../types";
import { getHrMinutesInRange } from "../metrics";
import { getProfileZoneModel } from "../zones";
import { getWeatherDaysForProfile } from "../weather-situations";
import {
  activityToEditData,
  getActiveCaloriesForActivities,
  getActivityById,
  getRoutePolylinesForActivities,
} from "./activities";
import { loadWeightsAsc } from "./common";

export interface RideDetailData {
  row: Activity;
  activityName: string;
  indoorOnly: boolean;
  activity: ActivityEditData;
  routePolyline: string | null;
  equipment: Equipment | null;
  bodyweightKg: number | null;
  calorieDisplay: ActivityCalorieDisplay | null;
  heartRateMinutes: { ts: string; bpm: number }[];
  heartRateWindow: ActivityWindow | null;
  zoneMinutes: number[] | null;
  zoneModel: ZoneModel | null;
  comparison: RideComparison | null;
  rideHistory: RideHistoryNeighbors;
  traces: RideTrace[];
  timedRoute: RideTimedRoutePoint[];
  powerCurve: PowerCurvePoint[];
  cyclingLoad: CyclingLoad | null;
  powerZones: PowerZoneRange[];
  powerZoneTimes: PowerZoneTime[];
  dynamics: RideDynamics | null;
  distanceSplits: RideDistanceSplit[];
  splitDistanceM: number;
  laps: RideLap[];
  segmentEfforts: RideSegmentEffort[];
  routeHistory: RideRouteHistory | null;
}

export interface RideLap {
  id: number;
  lapIndex: number;
  name: string | null;
  distanceM: number | null;
  movingTimeSec: number | null;
  elevationGainM: number | null;
  averageSpeedMps: number | null;
  averageCadence: number | null;
  averageWatts: number | null;
  averageHeartrate: number | null;
}

export interface RideSegmentEffort {
  id: number;
  name: string;
  distanceM: number | null;
  movingTimeSec: number | null;
  averageWatts: number | null;
  averageHeartrate: number | null;
  prRank: number | null;
  komRank: number | null;
}

export interface RideRouteHistory {
  rideCount: number;
  fastest: {
    id: number;
    date: string;
    title: string;
    speedKmh: number;
  } | null;
}

export interface CyclingOverviewPowerBest extends PowerCurvePoint {
  activityId: number;
  date: string;
  title: string;
}

export interface CyclingOverviewLoadPoint extends CyclingLoad {
  activityId: number;
  date: string;
  title: string;
}

export interface CyclingOverviewPowerZoneTime {
  zone: number;
  seconds: number;
  percent: number;
}

// The trailing window `zoneMinutes` covers. The overview's totals and records are
// all-time; its heart-rate distribution deliberately is NOT, so the surface has to
// be able to say which days it counted.
export interface CyclingZoneWindow {
  weeks: number;
  since: string; // inclusive first day, YYYY-MM-DD
  through: string; // inclusive last day (the activity's most recent ride)
}

export interface CyclingOverviewData {
  activityName: string;
  indoorOnly: boolean;
  rollup: CyclingOverviewRollup;
  distribution: CyclingDistribution;
  zoneModel: ZoneModel | null;
  zoneMinutes: number[] | null;
  zoneWindow: CyclingZoneWindow | null;
  powerBests: CyclingOverviewPowerBest[];
  loadPoints: CyclingOverviewLoadPoint[];
  latestFtpW: number | null;
  powerZoneTimes: CyclingOverviewPowerZoneTime[];
  telemetryRideCount: number;
  routeCount: number;
  uniqueRouteCount: number;
  segmentRideCount: number;
  segmentPersonalBestCount: number;
}

// One profile-scoped read model for the ride detail page. It enriches the same
// editor payload used by Journal with the ride's route, measured energy, gear,
// as-of bodyweight, and HR buckets bounded to this activity's clock window.
export function getRideDetailData(
  profileId: number,
  activityId: number,
  splitDistanceM = 5000
): RideDetailData | null {
  const row = getActivityById(profileId, activityId);
  if (!row || !isCyclingActivity(row)) return null;
  const activityName = cyclingActivityName(row)!;
  const { indoorOnly } = cyclingActivityPresentation(activityName);

  const routePolyline =
    getRoutePolylinesForActivities(profileId, [row.id]).get(row.id) ?? null;
  const measuredKcal =
    getActiveCaloriesForActivities(profileId, [row]).get(row.id) ?? null;
  const bodyweightKg = bodyweightAsOf(loadWeightsAsc(profileId), row.date);
  const calorieDisplay = activityCalorieDisplay(
    row,
    bodyweightKg,
    measuredKcal
  );
  const zoneModel = getProfileZoneModel(profileId);
  const heartRateWindow = activityWindows([row])[0] ?? null;
  const heartRateMinutes = (
    heartRateWindow
      ? scopeBucketsToWindows(
          // Include the following date so a ride crossing midnight keeps its
          // post-midnight buckets; the activity window still excludes every
          // unrelated minute.
          getHrMinutesInRange(profileId, row.date, shiftDateStr(row.date, 1)),
          [heartRateWindow]
        )
      : []
  ).sort((a, b) => a.ts.localeCompare(b.ts));
  const zoneMinutes = zoneModel
    ? zoneMinuteTotals(heartRateMinutes, zoneModel)
    : null;
  // The pure comparison model performs the final cycling-identity and similarity
  // checks. Read the full profile-scoped cycling candidate set so a ride can be
  // compared with every similar session, including sessions recorded later.
  const comparisonCandidates = db
    .prepare(
      `SELECT * FROM activities
        WHERE profile_id = ?
          AND type IN ('cardio', 'sport')
          AND id != ?
        ORDER BY date, id`
    )
    .all(profileId, row.id) as Activity[];
  const comparison = rideComparison(row, comparisonCandidates);
  const rideHistory = rideHistoryNeighbors(row, comparisonCandidates, 1);
  const telemetry = db
    .prepare(
      `SELECT streams_json, ftp_w, power_zones_json
         FROM activity_telemetry
        WHERE profile_id = ? AND activity_id = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, row.id) as
    | {
        streams_json: string;
        ftp_w: number | null;
        power_zones_json: string | null;
      }
    | undefined;
  const streams = parseCyclingStreams(telemetry?.streams_json ?? null);
  const traces = rideTraces(streams);
  const curve = powerCurve(streams);
  const powerZones = parsePowerZones(telemetry?.power_zones_json ?? null);
  const laps = db
    .prepare(
      `SELECT id, lap_index AS lapIndex, name, distance_m AS distanceM,
              moving_time_sec AS movingTimeSec,
              elevation_gain_m AS elevationGainM,
              average_speed_mps AS averageSpeedMps,
              average_cadence AS averageCadence,
              average_watts AS averageWatts,
              average_heartrate AS averageHeartrate
         FROM activity_laps
        WHERE profile_id = ? AND activity_id = ?
        ORDER BY lap_index, id`
    )
    .all(profileId, row.id) as RideLap[];
  const segmentEfforts = db
    .prepare(
      `SELECT id, name, distance_m AS distanceM,
              moving_time_sec AS movingTimeSec,
              average_watts AS averageWatts,
              average_heartrate AS averageHeartrate,
              pr_rank AS prRank, kom_rank AS komRank
         FROM activity_segment_efforts
        WHERE profile_id = ? AND activity_id = ?
        ORDER BY start_index, id`
    )
    .all(profileId, row.id) as RideSegmentEffort[];

  const fingerprint = routeFingerprint(routePolyline);
  const routeCandidates = fingerprint
    ? (db
        .prepare(
          `SELECT a.id, a.date, a.title, a.duration_min, a.distance_km,
                  a.avg_speed_kmh, r.polyline
             FROM activity_routes r
             JOIN activities a ON a.id = r.activity_id
            WHERE a.profile_id = ? AND a.id != ?
              AND (a.date < ? OR (a.date = ? AND a.id < ?))
            ORDER BY a.date DESC, a.id DESC
            LIMIT 200`
        )
        .all(profileId, row.id, row.date, row.date, row.id) as {
        id: number;
        date: string;
        title: string;
        duration_min: number | null;
        distance_km: number | null;
        avg_speed_kmh: number | null;
        polyline: string;
      }[])
    : [];
  const routeMatches = routeCandidates.filter(
    (candidate) => routeFingerprint(candidate.polyline) === fingerprint
  );
  const fastest = routeMatches
    .flatMap((candidate) => {
      const value =
        candidate.avg_speed_kmh ??
        speedKmh(candidate.distance_km, candidate.duration_min);
      return value == null
        ? []
        : [
            {
              id: candidate.id,
              date: candidate.date,
              title: candidate.title,
              speedKmh: value,
            },
          ];
    })
    .sort((a, b) => b.speedKmh - a.speedKmh)[0];
  const routeHistory =
    routeMatches.length > 0
      ? { rideCount: routeMatches.length, fastest: fastest ?? null }
      : null;
  const activity = activityToEditData(profileId, row);
  activity.imported_metrics = pickImportedActivityMetrics(row, measuredKcal);
  activity.calorie_kcal = calorieDisplay?.kcal ?? null;
  activity.calorie_estimated = calorieDisplay?.estimated ?? false;
  activity.route_polyline = routePolyline;
  activity.heart_rate_zone =
    zoneModel && row.avg_hr != null ? zoneForBpm(row.avg_hr, zoneModel) : null;

  return {
    row,
    activityName,
    indoorOnly,
    activity,
    routePolyline,
    equipment:
      row.equipment_id != null
        ? (getEquipmentById(profileId, row.equipment_id) ?? null)
        : null,
    bodyweightKg,
    calorieDisplay,
    heartRateMinutes,
    heartRateWindow,
    zoneMinutes,
    zoneModel,
    comparison,
    rideHistory,
    traces,
    timedRoute: rideTimedRoutePoints(streams),
    powerCurve: curve,
    cyclingLoad: cyclingLoad(
      telemetry?.ftp_w ?? null,
      row.weighted_avg_power_w,
      row.duration_min
    ),
    powerZones,
    powerZoneTimes: powerZoneTimes(streams, powerZones),
    dynamics: rideDynamics(streams),
    distanceSplits: distanceSplits(streams, splitDistanceM),
    splitDistanceM,
    laps,
    segmentEfforts,
    routeHistory,
  };
}

// Zone minutes for the overview's windowed distribution: per-minute HR bounded to
// the window, then scoped to the activity's own ride clocks. `until` reaches the
// day after the last ride so a session crossing midnight keeps its post-midnight
// buckets, exactly as the ride detail read does.
function cyclingZoneMinutes(
  profileId: number,
  window: CyclingZoneWindow,
  windows: ActivityWindow[],
  zoneModel: ZoneModel
): number[] {
  return zoneMinuteTotals(
    scopeBucketsToWindows(
      getHrMinutesInRange(
        profileId,
        window.since,
        shiftDateStr(window.through, 1)
      ),
      windows
    ),
    zoneModel
  );
}

// Profile-scoped all-ride read model for Training → Analyze → Cycling. The
// generic cardio aggregator owns per-session chart rows; this model adds the
// cycling-only context that exists below the activity row: rolling form,
// heart-rate zones, telemetry power bests/load, routes, and segment results.
export function getCyclingOverviewData(
  profileId: number,
  activityName = "Cycling"
): CyclingOverviewData {
  return readTx(() => {
    const presentation = cyclingActivityPresentation(activityName);
    const activityKey = activityHistoryKey(activityName);
    const rides = (
      db
        .prepare(
          `SELECT * FROM activities
            WHERE profile_id = ? AND type IN ('cardio', 'sport')
            ORDER BY date, id`
        )
        .all(profileId) as Activity[]
    ).filter(
      (ride) =>
        isCyclingActivity(ride) &&
        activityHistoryKey(cyclingActivityName(ride)!) === activityKey
    );
    const rideIds = new Set(rides.map((ride) => ride.id));
    const todayStr = today(profileId);
    const rollup = cyclingOverviewRollup(
      rides.map((ride) => ({
        id: ride.id,
        date: ride.date,
        title: ride.title,
        durationMin: ride.duration_min,
        distanceKm: ride.distance_km,
        avgSpeedKmh: ride.avg_speed_kmh,
        elevationM: presentation.indoorOnly ? null : ride.elevation_m,
        avgPowerW: ride.avg_power_w,
        kilojoules: ride.kilojoules,
      })),
      todayStr
    );
    const firstRideDate = rides[0]?.date;
    const weatherDays =
      firstRideDate && !presentation.indoorOnly
        ? getWeatherDaysForProfile(
            profileId,
            firstRideDate < todayStr ? firstRideDate : todayStr,
            todayStr
          )
        : [];
    const distribution = cyclingDistribution(rides, weatherDays, todayStr, {
      singular: presentation.noun,
      plural: presentation.pluralNoun,
    });

    // #2292: this read deliberately does NOT select `streams_json`. The two things
    // the overview derives from a ride's streams — the power curve and per-zone
    // seconds — are precomputed at ingest into `stream_summary_json`, which is a
    // few numbers per ride rather than a ride's worth of per-second samples. The
    // page used to parse every stream blob the profile owned on every load, so its
    // cost grew with total ride history IN BYTES PARSED.
    //
    // NOT WINDOWED, unlike the heart-rate distribution a few lines below (#2197).
    // Both values here are ALL-TIME CLAIMS: the card says "Personal best rolling
    // efforts", and bounding it to a training block would leave it saying "personal
    // best" while meaning "best since March". Different answers on one page, on
    // purpose — see lib/cycling-stream-summary.ts for the full reasoning.
    const telemetryRows = db
      .prepare(
        `SELECT id, activity_id, stream_summary_json, ftp_w, snapshot_at
           FROM activity_telemetry
          WHERE profile_id = ?
          ORDER BY snapshot_at, id`
      )
      .all(profileId) as {
      id: number;
      activity_id: number;
      stream_summary_json: string | null;
      ftp_w: number | null;
      snapshot_at: string;
    }[];
    // One effective telemetry snapshot per ride. A profile may have rows from
    // more than one source; the newest snapshot is the overview's read model.
    const telemetryByRide = new Map(
      telemetryRows
        .filter((row) => rideIds.has(row.activity_id))
        .map((row) => [row.activity_id, row] as const)
    );
    const powerBestBySeconds = new Map<number, CyclingOverviewPowerBest>();
    const loadPoints: CyclingOverviewLoadPoint[] = [];
    const powerZoneSeconds: number[] = [];
    let latestFtpW: number | null = null;
    for (const ride of rides) {
      const telemetry = telemetryByRide.get(ride.id);
      if (!telemetry) continue;
      // Null when the row has no summary yet or carries one made by a different
      // rule. That ride contributes no power values this load; the boot reconcile
      // (lib/cycling-stream-summary-db.ts) re-derives it. Deliberately NOT a
      // fallback to parsing the streams — that would restore the unbounded read.
      const summary = parseCyclingStreamSummary(telemetry.stream_summary_json);
      for (const point of summary?.powerCurve ?? []) {
        // The label is presentation and is re-attached here rather than frozen
        // into the stored row; a duration the app no longer shows is dropped.
        const label = powerCurveLabel(point.seconds);
        if (label == null) continue;
        const prior = powerBestBySeconds.get(point.seconds);
        if (!prior || point.watts >= prior.watts) {
          powerBestBySeconds.set(point.seconds, {
            seconds: point.seconds,
            label,
            watts: point.watts,
            activityId: ride.id,
            date: ride.date,
            title: ride.title,
          });
        }
      }
      const load = cyclingLoad(
        telemetry.ftp_w,
        ride.weighted_avg_power_w,
        ride.duration_min
      );
      if (load) {
        loadPoints.push({
          ...load,
          activityId: ride.id,
          date: ride.date,
          title: ride.title,
        });
      }
      if (telemetry.ftp_w != null && telemetry.ftp_w > 0) {
        latestFtpW = telemetry.ftp_w;
      }
      (summary?.powerZoneSeconds ?? []).forEach((seconds, index) => {
        powerZoneSeconds[index] = (powerZoneSeconds[index] ?? 0) + seconds;
      });
    }
    const totalPowerZoneSeconds = powerZoneSeconds.reduce(
      (sum, seconds) => sum + seconds,
      0
    );
    const overviewPowerZones = powerZoneSeconds.map((seconds, index) => ({
      zone: index + 1,
      seconds,
      percent:
        totalPowerZoneSeconds > 0
          ? Math.round((seconds / totalPowerZoneSeconds) * 100)
          : 0,
    }));

    const zoneModel = getProfileZoneModel(profileId);
    const windows = activityWindows(rides);
    const lastRideDate = rides.at(-1)?.date;
    // The zone distribution is the one part of this otherwise all-time model that
    // is WINDOWED (#2197). Reading per-minute HR from the first ride ever is an
    // unbounded scan that grows with account age, on every load of this page. It
    // takes the SAME declared block width as the Trends Fitness zone section
    // (ZONE_WINDOW_WEEKS) — the question is the same one, only filtered to this
    // bike — and differs solely in the anchor: the most recent ride rather than
    // today, so an activity parked for a season still shows the shape of its last
    // block instead of an empty card.
    const zoned =
      zoneModel && windows.length > 0 && lastRideDate
        ? {
            model: zoneModel,
            window: {
              weeks: ZONE_WINDOW_WEEKS,
              since: zoneWindowSince(lastRideDate),
              through: lastRideDate,
            } satisfies CyclingZoneWindow,
          }
        : null;
    const zoneWindow = zoned?.window ?? null;
    const zoneMinutes = zoned
      ? cyclingZoneMinutes(profileId, zoned.window, windows, zoned.model)
      : null;

    const routes = db
      .prepare(
        `SELECT r.activity_id, r.polyline
           FROM activity_routes r
           JOIN activities a ON a.id = r.activity_id
          WHERE a.profile_id = ?`
      )
      .all(profileId) as { activity_id: number; polyline: string }[];
    const cyclingRoutes = presentation.indoorOnly
      ? []
      : routes.filter((route) => rideIds.has(route.activity_id));
    const uniqueRoutes = new Set(
      cyclingRoutes
        .map((route) => routeFingerprint(route.polyline))
        .filter((value): value is string => value != null)
    );
    const segmentRows = db
      .prepare(
        `SELECT s.activity_id, s.pr_rank
           FROM activity_segment_efforts s
           JOIN activities a ON a.id = s.activity_id
          WHERE a.profile_id = ?`
      )
      .all(profileId) as { activity_id: number; pr_rank: number | null }[];
    const cyclingSegmentRows = presentation.indoorOnly
      ? []
      : segmentRows.filter((row) => rideIds.has(row.activity_id));

    return {
      activityName,
      indoorOnly: presentation.indoorOnly,
      rollup,
      distribution,
      zoneModel,
      zoneMinutes,
      zoneWindow,
      powerBests: [...powerBestBySeconds.values()].sort(
        (a, b) => a.seconds - b.seconds
      ),
      loadPoints,
      latestFtpW,
      powerZoneTimes: overviewPowerZones,
      telemetryRideCount: telemetryByRide.size,
      routeCount: cyclingRoutes.length,
      uniqueRouteCount: uniqueRoutes.size,
      segmentRideCount: new Set(
        cyclingSegmentRows.map((row) => row.activity_id)
      ).size,
      segmentPersonalBestCount: cyclingSegmentRows.filter(
        (row) => row.pr_rank === 1
      ).length,
    };
  });
}
