import { db } from "../../db";

export interface SessionLap {
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

export interface SessionSegmentEffort {
  id: number;
  name: string;
  distanceM: number | null;
  movingTimeSec: number | null;
  averageWatts: number | null;
  averageHeartrate: number | null;
  prRank: number | null;
  komRank: number | null;
}

export function getSessionCourseData(
  profileId: number,
  activityId: number
): {
  laps: SessionLap[];
  segmentEfforts: SessionSegmentEffort[];
} {
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
    .all(profileId, activityId) as SessionLap[];
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
    .all(profileId, activityId) as SessionSegmentEffort[];
  return { laps, segmentEfforts };
}
