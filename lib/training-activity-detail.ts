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
import { isDraftActivityRow } from "./activity-draft";
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
import { activityWindow, windowsOverlap } from "./import-review/detect";
import { sessionComparison, type RideComparison } from "./ride-detail";
import { isSameActivityKind } from "./cycling-activity";
import { getExerciseComparison } from "./queries/training/strength";
import { equipmentLoadLane } from "./lifts";
import { sessionProgressDelta, type ProgressDelta } from "./progress-delta";
import {
  distanceSplits,
  parseActivityStreams,
  rideTraces,
  type RideDistanceSplit,
  type RideTrace,
} from "./cycling-analytics";
import {
  paceHrDecouplingPercent,
  sessionSplitIntervalM,
} from "./session-analytics";
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

// What the SOURCE holds second-by-second for this session (#2870 step 4 widened
// the fetch past cycling, so a run or a walk has these too). The distinction the
// page needs is three-way, not two: traces to draw, or a source that answered
// with nothing ("totals only" — the honest line, #3009), or no answer yet.
export interface ActivityDetailTelemetry {
  traces: RideTrace[];
  // Per-unit splits from the recorded distance+time (#3009), cut at the reader's
  // own unit rather than a ride's 5 km. Empty when the session recorded no
  // distance stream, or covered less than a third of one interval.
  splits: RideDistanceSplit[];
  // The metres one split covers, so the surface can say which unit it cut at.
  splitIntervalM: number;
  // Aerobic decoupling: output-per-heartbeat lost between the halves, over PACE
  // for a worn session (the ride page asks the same question over power). Null
  // whenever the recording cannot answer it honestly.
  decouplingPercent: number | null;
  // The source has told us what it holds: a telemetry row exists. Without one
  // the session simply has not been asked about (a manual entry, or an import
  // that predates the widening), which is not the same as "there is nothing".
  answered: boolean;
}

export interface ActivityDetailData {
  row: Activity;
  card: TrainingLogCardData;
  // The other activities of the same day — the card menu's manual-merge targets
  // (issue #64), shaped exactly as TrainingLogView ships them.
  siblings: ActivityDetailSibling[];
  heartRate: ActivityDetailHeartRate;
  telemetry: ActivityDetailTelemetry;
  // The same-day siblings whose clock window OVERLAPS this activity's (#2870) —
  // a subset of `siblings`, so the banner and the merge picker are talking about
  // the same rows. Empty when this activity has no clock, which is not evidence
  // of anything either way.
  overlappingSiblings: ActivityDetailSibling[];
  // How this session sits against its like-for-like peers (#3009): same kind of
  // session, within a tolerance of the same distance, each metric against the
  // median of the peers that carry it. Null when there are no comparable peers —
  // for endurance, a personal baseline beats any published standard, and the
  // absence of one is not a zero.
  comparison: RideComparison | null;
  // "vs last" per rendered part, INDEX-ALIGNED with `card.parts` (#2870). Null
  // where the part is not a lift, or the lift has no comparable previous session
  // on the same implement. Computed for the canonical PAGE only: the reading
  // pane renders from feed data with no fetch (#2897), and one history scan per
  // exercise per card is not a price a browse surface should pay.
  partDeltas: (ProgressDelta | null)[];
  // Adjacent activities in ledger order (date, then id) for ‹ older / newer ›.
  olderId: number | null;
  newerId: number | null;
  // A create-at-start session that never logged anything (#2870 step 3): this
  // page is its ONLY address (the feed hides it), so the page must say so and
  // offer the discard.
  isDraft: boolean;
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

  // The source's second-by-second record, through the same pure derivation the
  // ride page uses — nothing in `rideTraces` is about bicycles.
  const telemetryRow = db
    .prepare(
      `SELECT streams_json FROM activity_telemetry
        WHERE profile_id = ? AND activity_id = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, row.id) as { streams_json: string | null } | undefined;
  const streams = parseActivityStreams(telemetryRow?.streams_json ?? null);
  const splitIntervalM = sessionSplitIntervalM(
    row.distance_km,
    units.distanceUnit
  );
  const telemetry: ActivityDetailTelemetry = {
    traces: rideTraces(streams),
    splits: distanceSplits(streams, splitIntervalM),
    splitIntervalM,
    decouplingPercent: paceHrDecouplingPercent(streams),
    answered: !!telemetryRow,
  };

  // The same-day sibling that OVERLAPS this one on the clock (#2870). In the log,
  // a double-logged session announced itself by sitting next to its twin; a page
  // shows one activity, so that adjacency — and with it the whole discovery of a
  // duplicate — is gone unless the record says so. Overlap is the same evidence
  // the duplicate detector treats as its strongest signal (you cannot do two
  // sessions at once), read through the detector's own primitives so this can
  // never drift into a second definition of "the same session twice".
  const myWindow = activityWindow(row);
  const overlappingSiblings: ActivityDetailSibling[] = myWindow
    ? siblings.filter((sib) => {
        const other = dayRows.find((a) => a.id === sib.id);
        if (!other) return false;
        const window = activityWindow(other);
        return !!window && windowsOverlap(myWindow, window);
      })
    : [];

  // Like-for-like peers (#3009 / #2566's `rideComparison` → `sessionComparison`).
  // Bounded to the recent history of the same activity TYPE: the peer rule then
  // narrows by kind and distance, so the scan never walks a whole ledger to find
  // a handful of comparable walks.
  const peerRows = db
    .prepare(
      `SELECT * FROM activities
        WHERE profile_id = ? AND type = ? AND id != ?
        ORDER BY date DESC, id DESC LIMIT 200`
    )
    .all(profileId, row.type, row.id) as Activity[];
  const comparison = sessionComparison(row, peerRows, {
    isPeer: isSameActivityKind,
  });

  // "vs last" (#2870). One history scan per DISTINCT lift in this session, each
  // narrowed to the implement its sets were performed on — the same
  // `equipmentLoadLane` identity every load-sensitive builder keys on (#1610), so
  // a hotel machine's 50 kg never reads as a collapse against the home machine's
  // 80. `getExerciseComparison` already excludes warm-ups (#338) and returns
  // sessions oldest-first, so "last" is simply the entry before this activity's.
  const mySets = sets.filter((s) => s.activity_id === row.id);
  const deltaByExercise = new Map<string, ProgressDelta | null>();
  for (const part of card.parts) {
    if (part.kind !== "strength") continue;
    if (deltaByExercise.has(part.name)) continue;
    const partSets = mySets.filter(
      (s) => s.exercise.trim().toLowerCase() === part.name.trim().toLowerCase()
    );
    const lane = equipmentLoadLane(partSets[0]?.equipment_id ?? null);
    const history = getExerciseComparison(
      profileId,
      part.name,
      units.weightUnit,
      {
        equipmentLane: lane,
      }
    );
    const index = history.findIndex((s) => s.activityId === row.id);
    const previous = index > 0 ? history[index - 1] : null;
    deltaByExercise.set(
      part.name,
      previous && index >= 0
        ? sessionProgressDelta(history[index], previous, units.weightUnit)
        : null
    );
  }
  const partDeltas = card.parts.map((part) =>
    part.kind === "strength" ? (deltaByExercise.get(part.name) ?? null) : null
  );

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
    telemetry,
    overlappingSiblings,
    comparison,
    partDeltas,
    olderId,
    newerId,
    isDraft: isDraftActivityRow(
      row,
      sets.filter((s) => s.activity_id === row.id).length
    ),
  };
}
