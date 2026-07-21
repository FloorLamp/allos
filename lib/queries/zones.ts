// Training intensity distribution — DB read/derive layer (issue #159). Assembles
// the profile's HR zone model (from age / latest resting HR / manual override) and
// the window-scoped per-minute HR into weekly zone minutes, Zone 2 volume vs the
// target, and the easy/hard polarization split. The math is all pure
// (lib/training-zones); this layer only fetches profile-scoped rows and threads in
// the profile's settings (max-HR override, Zone 2 target, week-start, timezone).
import { db, today } from "../db";
import { shiftDateStr } from "../date";
import { weekWindow } from "../week-window";
import { getHrMinutesInRange, getLatestBodyMetric } from "./metrics";
import {
  getMaxHrOverride,
  getUserAge,
  getWeekMode,
  getWeekStart,
  getZone2WeeklyTargetMin,
} from "../settings";
import {
  activityWindows,
  buildZoneModel,
  dayPlannedIntent,
  fillZoneWeeks,
  polarizedSplit,
  scopeBucketsToWindows,
  weeklyZoneMinutes,
  zone2Adherence,
  zoneMinuteTotals,
  AEROBIC_THRESHOLD_ZONE,
  type ActivityWindowInput,
  type DayLoadInput,
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
// defaults to open-ended). ts is 'YYYY-MM-DDTHH:MM' profile-local. Reads through
// the shared one-source-per-day HR read (issue #14) so a workout recorded by two
// HR sources at once can't double its zone minutes.
function hrBuckets(
  profileId: number,
  since: string,
  until?: string
): HrBucket[] {
  return getHrMinutesInRange(profileId, since, until);
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
  // weeklyZoneMinutes returns only weeks with data; zero-fill the gaps so a
  // training pause renders as empty weeks instead of compressing away (issue #406)
  // — otherwise a January and a May bar sit adjacent and the Zone-2 target line
  // implies adherence over months that were actually zero.
  const rows = fillZoneWeeks(
    weeklyZoneMinutes(scoped, model, weekStart),
    weeks
  );
  // The headline "this week" adherence stat honors the profile's week_mode via the
  // SHARED weekWindow() (#223) and the SAME getZone2MinutesInWindow the weekly
  // recap uses (#397) — so a rolling-week profile's zone card and its recap can't
  // report two different Zone 2 numbers for one target. The chart's calendar
  // buckets (rows) stay calendar-anchored: "this week so far" and "each calendar
  // week" are different questions.
  const win = weekWindow(td, getWeekMode(profileId), weekStart);
  const currentWeekZone2 = zone2Adherence(
    getZone2MinutesInWindow(profileId, win.start, win.end) ?? 0,
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

// Per-day load inputs (issue #754) over a trailing window: for each day with a
// logged activity, its easy/hard HR split (when window-scoped HR covers it), its total
// session minutes, and its SUBJECTIVE planned-intent (from `activities.intensity`, the
// #1115 Fix A′ seam), ready for the pure isLoadingDay classifier. The coaching gather
// runs these through loadingDates() so the overtraining/load rest triggers key on hard
// sessions, not every activity: a self-rated easy day breaks the streak even long/
// un-zoned, a self-rated hard day counts even under the duration floor.
export function getDayLoadInputs(profileId: number, days = 42): DayLoadInput[] {
  const td = today(profileId);
  const since = shiftDateStr(td, -(days - 1));

  // Total session minutes per day from all activities (the duration fallback), plus the
  // day's subjective intensity ratings collapsed to a planned intent. duration_min is
  // stored regardless of a start time, so this also covers days with no bounded HR
  // window. GROUP_CONCAT drops NULL ratings, so an unrated day yields no intent.
  const durRows = db
    .prepare(
      `SELECT date, COALESCE(SUM(duration_min), 0) AS dur,
              GROUP_CONCAT(intensity) AS intensities
         FROM activities
        WHERE profile_id = ? AND date >= ?
        GROUP BY date`
    )
    .all(profileId, since) as {
    date: string;
    dur: number;
    intensities: string | null;
  }[];
  const byDate = new Map<string, DayLoadInput>();
  for (const r of durRows) {
    byDate.set(r.date, {
      date: r.date,
      durationMin: r.dur > 0 ? r.dur : null,
      plannedIntent: dayPlannedIntent(
        r.intensities ? r.intensities.split(",") : []
      ),
    });
  }

  // Per-day easy/hard split from window-scoped HR buckets, when a zone model exists.
  const model = getProfileZoneModel(profileId);
  if (model) {
    const buckets = hrBuckets(profileId, since);
    const windows = activityWindows(activityWindowInputs(profileId, since));
    const scoped = scopeBucketsToWindows(buckets, windows);
    const byDay = new Map<string, HrBucket[]>();
    for (const b of scoped) {
      const day = b.ts.slice(0, 10);
      let arr = byDay.get(day);
      if (!arr) byDay.set(day, (arr = []));
      arr.push(b);
    }
    for (const [day, bs] of byDay) {
      const split = polarizedSplit(bs, model);
      byDate.set(day, {
        ...(byDate.get(day) ?? { date: day }),
        date: day,
        split,
      });
    }
  }

  return [...byDate.values()];
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
