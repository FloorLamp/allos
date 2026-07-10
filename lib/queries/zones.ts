// Training intensity distribution — DB read/derive layer (issue #159). Assembles
// the profile's HR zone model (from age / latest resting HR / manual override) and
// the window-scoped per-minute HR into weekly zone minutes, Zone 2 volume vs the
// target, and the easy/hard polarization split. The math is all pure
// (lib/training-zones); this layer only fetches profile-scoped rows and threads in
// the profile's settings (max-HR override, Zone 2 target, week-start, timezone).
import { db, today } from "../db";
import { shiftDateStr, startOfWeekStr } from "../date";
import { getLatestBodyMetric } from "./metrics";
import {
  getMaxHrOverride,
  getUserAge,
  getWeekStart,
  getZone2WeeklyTargetMin,
} from "../settings";
import {
  activityWindows,
  buildZoneModel,
  polarizedSplit,
  scopeBucketsToWindows,
  weeklyZoneMinutes,
  zone2Adherence,
  zone2Minutes,
  zoneMinuteTotals,
  AEROBIC_THRESHOLD_ZONE,
  type ActivityWindowInput,
  type HrBucket,
  type PolarizedSplit,
  type WeeklyZoneMinutes,
  type Zone2Adherence,
  type ZoneModel,
} from "../training-zones";

// Activities on/after `since` that have a start time (so a window can be bounded).
// Profile-scoped; the window math drops any that still can't be bounded.
function activityWindowInputs(
  profileId: number,
  since: string
): ActivityWindowInput[] {
  return db
    .prepare(
      `SELECT date, start_time, end_time, duration_min
         FROM activities
        WHERE profile_id = ? AND date >= ? AND start_time IS NOT NULL`
    )
    .all(profileId, since) as ActivityWindowInput[];
}

// Per-minute HR buckets within an inclusive [since, until] date range (until
// defaults to open-ended). ts is 'YYYY-MM-DDTHH:MM' profile-local.
function hrBuckets(
  profileId: number,
  since: string,
  until?: string
): HrBucket[] {
  if (until != null) {
    return db
      .prepare(
        `SELECT ts, bpm FROM hr_minutes
          WHERE profile_id = ? AND substr(ts,1,10) >= ? AND substr(ts,1,10) <= ?`
      )
      .all(profileId, since, until) as HrBucket[];
  }
  return db
    .prepare(
      `SELECT ts, bpm FROM hr_minutes
        WHERE profile_id = ? AND substr(ts,1,10) >= ?`
    )
    .all(profileId, since) as HrBucket[];
}

// The profile's zone model, or null when no max HR can be resolved (no age and no
// override). Resting HR (latest body_metrics reading) enables Karvonen.
export function getProfileZoneModel(profileId: number): ZoneModel | null {
  return buildZoneModel({
    age: getUserAge(profileId),
    restingHr: getLatestBodyMetric(profileId, "resting_hr"),
    maxHrOverride: getMaxHrOverride(profileId),
  });
}

export interface TrainingZoneData {
  model: ZoneModel | null;
  weeks: WeeklyZoneMinutes[]; // oldest→newest, only weeks with training HR
  zone2Target: number; // weekly Zone 2 minutes target (0 = none)
  currentWeekZone2: Zone2Adherence | null;
  split: PolarizedSplit; // easy/hard over the whole window
  hasHrData: boolean; // any HR buckets exist in the window at all
  windowWeeks: number;
}

// Everything the Trends Fitness zone section needs, over the trailing `weeks`
// weeks. hasHrData distinguishes "no zone model" (needs age/override) from "model
// but no synced HR yet" so the surface can explain the right next step.
export function getTrainingZoneData(
  profileId: number,
  weeks = 12
): TrainingZoneData {
  const td = today(profileId);
  const since = shiftDateStr(td, -(weeks * 7 - 1));
  const zone2Target = getZone2WeeklyTargetMin(profileId);
  const model = getProfileZoneModel(profileId);
  const buckets = hrBuckets(profileId, since);
  const hasHrData = buckets.length > 0;

  const emptySplit: PolarizedSplit = {
    easyMin: 0,
    hardMin: 0,
    totalMin: 0,
    easyPct: 0,
    hardPct: 0,
  };

  if (!model) {
    return {
      model: null,
      weeks: [],
      zone2Target,
      currentWeekZone2: null,
      split: emptySplit,
      hasHrData,
      windowWeeks: weeks,
    };
  }

  const weekStart = getWeekStart(profileId);
  const windows = activityWindows(activityWindowInputs(profileId, since));
  const scoped = scopeBucketsToWindows(buckets, windows);
  const rows = weeklyZoneMinutes(scoped, model, weekStart);
  const currentWeek = startOfWeekStr(td, weekStart);
  const currentRow = rows.find((r) => r.week === currentWeek);
  const currentWeekZone2 = zone2Adherence(
    zone2Minutes(currentRow),
    zone2Target
  );
  const split = polarizedSplit(scoped, model);

  return {
    model,
    weeks: rows,
    zone2Target,
    currentWeekZone2,
    split,
    hasHrData,
    windowWeeks: weeks,
  };
}

// Zone 2 minutes over an inclusive [start, end] date window (both YYYY-MM-DD in the
// profile timezone) — for the weekly recap line. Returns null when no zone model
// exists. Pass the recap window's start/end (a days-1 inclusive window).
export function getZone2MinutesInWindow(
  profileId: number,
  start: string,
  end: string
): number | null {
  const model = getProfileZoneModel(profileId);
  if (!model) return null;
  const buckets = hrBuckets(profileId, start, end);
  const windows = activityWindows(activityWindowInputs(profileId, start));
  const scoped = scopeBucketsToWindows(buckets, windows);
  return zoneMinuteTotals(scoped, model)[AEROBIC_THRESHOLD_ZONE - 1];
}

// The easy/hard polarization split over a trailing rolling window (default 6
// weeks), for the coaching engine's hard-heavy nudge. Null when no zone model.
export function getIntensitySignal(
  profileId: number,
  days = 42
): PolarizedSplit | null {
  const model = getProfileZoneModel(profileId);
  if (!model) return null;
  const td = today(profileId);
  const since = shiftDateStr(td, -(days - 1));
  const buckets = hrBuckets(profileId, since);
  const windows = activityWindows(activityWindowInputs(profileId, since));
  const scoped = scopeBucketsToWindows(buckets, windows);
  return polarizedSplit(scoped, model);
}
