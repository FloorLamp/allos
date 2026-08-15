// Assemble one activity's canonical page (#2870 step 1). The record IS the
// Training Log card — this module builds the SAME card the log builds, by
// running the same pure buildTrainingLogCards over the activity's whole DAY,
// then picking the target out of the group. Building the day (not the lone row)
// is what makes the card's merge affordance honest for free: its siblings are
// exactly the other cards of that day, the way TrainingLogView derives them.
//
// The heart-rate block mirrors the ride page's assembly (activityWindows →
// getHrMinutesInRange scoped to the window → zoneMinuteTotals) — the pipeline
// #2566 ordered cut type-agnostic, consumed here for every activity type.
// Not pure (reads DB + settings); takes the resolved profile + unit prefs.

import {
  getSetsForActivities,
  getRoutePolylinesForActivities,
  getActiveCaloriesForActivities,
  getWeights,
} from "./queries";
import { getEquipment } from "./equipment";
import { getActivityVideosForActivities } from "./activity-video-write";
import {
  buildTrainingLogCards,
  type TrainingLogCardData,
} from "./training-log-card";
import type { DatedWeight } from "./calorie-estimate";
import type { UnitPrefs } from "./settings";
import { DEFAULT_FORMAT_PREFS, type DisplayFormatPrefs } from "./format-date";
import { db, today as todayFn, yesterday as yesterdayFn } from "./db";
import { shiftDateStr } from "./date";
import { getProfileZoneModel } from "./queries/zones";
import { getWeatherDaysForProfile } from "./queries/weather-situations";
import { getHrMinutesInRange } from "./queries/metrics";
import {
  activityWindows,
  scopeBucketsToWindows,
  zoneMinuteTotals,
  type ActivityWindow,
  type ZoneModel,
} from "./training-zones";
import type { Activity } from "./types";

// Structurally identical to the card menu's MergeSibling — declared here so lib
// does not import an app-layer module; the page passes these straight through.
export interface ActivityDetailSibling {
  id: number;
  title: string;
  sourceLabel: string;
  foldValues: Record<string, unknown>;
  setCount: number;
}

export interface ActivityDetailHeartRate {
  window: ActivityWindow | null;
  minutes: { ts: string; bpm: number }[];
  zoneMinutes: number[] | null;
  zoneModel: ZoneModel | null;
}

export interface ActivityDetailData {
  row: Activity;
  card: TrainingLogCardData;
  // The other activities of the same day — the card menu's manual-merge targets
  // (issue #64), shaped exactly as TrainingLogView ships them.
  siblings: ActivityDetailSibling[];
  heartRate: ActivityDetailHeartRate;
  // Adjacent activities in ledger order (date, then id) for ‹ older / newer ›.
  olderId: number | null;
  newerId: number | null;
}

export function getActivityDetailData(
  profileId: number,
  activityId: number,
  units: UnitPrefs,
  formatPrefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): ActivityDetailData | null {
  const row = db
    .prepare(`SELECT * FROM activities WHERE profile_id = ? AND id = ?`)
    .get(profileId, activityId) as Activity | undefined;
  if (!row) return null;

  const dayRows = db
    .prepare(
      `SELECT * FROM activities WHERE profile_id = ? AND date = ? ORDER BY id`
    )
    .all(profileId, row.date) as Activity[];
  const dayIds = dayRows.map((a) => a.id);

  const sets = getSetsForActivities(profileId, dayIds);
  const routes = getRoutePolylinesForActivities(profileId, dayIds);
  const activeCalories = getActiveCaloriesForActivities(profileId, dayRows);
  const activityVideos = getActivityVideosForActivities(profileId, dayIds);
  const equipmentNames = new Map(
    getEquipment(profileId, { includeRetired: true }).map((e) => [e.id, e.name])
  );
  const weights: DatedWeight[] = getWeights(profileId).map((w) => ({
    date: w.date,
    weightKg: w.weight_kg,
  }));
  const weatherByDate = new Map<
    string,
    { tempMaxC: number | null; weatherCode: number | null }
  >();
  for (const d of getWeatherDaysForProfile(profileId, row.date, row.date)) {
    weatherByDate.set(d.date, {
      tempMaxC: d.tempMaxC,
      weatherCode: d.weatherCode,
    });
  }

  const zoneModel = getProfileZoneModel(profileId);
  const groups = buildTrainingLogCards({
    activities: dayRows,
    sets,
    equipmentNames,
    weights,
    units,
    formatPrefs,
    today: todayFn(profileId),
    yesterday: yesterdayFn(profileId),
    routes,
    activeCalories,
    zoneModel,
    activityVideos,
    weatherByDate,
  });
  const cards = groups[0]?.cards ?? [];
  const card = cards.find((c) => c.activity.id === activityId);
  if (!card) return null;

  const siblings: ActivityDetailSibling[] = cards
    .filter((c) => c.activity.id !== activityId)
    .map((c) => ({
      id: c.activity.id,
      title: c.activity.title,
      sourceLabel: c.provenance.label,
      foldValues: c.foldValues,
      setCount: c.parts.length,
    }));

  // The ride page's HR assembly, unchanged in shape: the activity's own time
  // window scopes the profile's minute buckets, spilling into the next date so
  // a session crossing midnight keeps its tail.
  const heartRateWindow = activityWindows([row])[0] ?? null;
  const minutes = (
    heartRateWindow
      ? scopeBucketsToWindows(
          getHrMinutesInRange(profileId, row.date, shiftDateStr(row.date, 1)),
          [heartRateWindow]
        )
      : []
  ).sort((a, b) => a.ts.localeCompare(b.ts));
  const zoneMinutes =
    zoneModel && minutes.length > 0
      ? zoneMinuteTotals(minutes, zoneModel)
      : null;

  const olderId =
    (
      db
        .prepare(
          `SELECT id FROM activities
            WHERE profile_id = ? AND (date < ? OR (date = ? AND id < ?))
            ORDER BY date DESC, id DESC LIMIT 1`
        )
        .get(profileId, row.date, row.date, row.id) as
        { id: number } | undefined
    )?.id ?? null;
  const newerId =
    (
      db
        .prepare(
          `SELECT id FROM activities
            WHERE profile_id = ? AND (date > ? OR (date = ? AND id > ?))
            ORDER BY date ASC, id ASC LIMIT 1`
        )
        .get(profileId, row.date, row.date, row.id) as
        { id: number } | undefined
    )?.id ?? null;

  return {
    row,
    card,
    siblings,
    heartRate: { window: heartRateWindow, minutes, zoneMinutes, zoneModel },
    olderId,
    newerId,
  };
}
