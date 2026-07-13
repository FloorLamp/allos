import { db } from "@/lib/db";
import type { ActivityType, ActivityComponent } from "@/lib/types";
import {
  hasBodyMetric,
  mergeBodyMetricPartialAware,
  type BodyMetricValues,
} from "@/lib/body-metric-extract";
import { collapseBodyMetricsByDate } from "./body-metric-collapse";
import { emptyCounts, rowsEqual, isEditLocked } from "./sync-log";
import type { UpsertCounts } from "./sync-log";
import { loadImportTombstones } from "./tombstones";
import {
  bodyMetricTombstoneKey,
  metricSampleTombstoneKey,
} from "./tombstone-keys";

// Provider-agnostic record shapes. Every integration parses its own payload into
// these, then calls the shared upserts below — so a new provider (Strava, Garmin)
// reuses all of the DB mapping and idempotency logic.

// Per-day body metrics. weight_kg may be undefined (e.g. a body-fat-only day).
export interface NormBodyMetric {
  date: string; // YYYY-MM-DD (local)
  weight_kg?: number;
  body_fat_pct?: number;
  resting_hr?: number;
  // The absolute instant (ISO) this reading was taken. Only used to collapse multiple
  // same-date readings within a batch deterministically (#605) — the LATEST non-null
  // value wins per field. Providers that already emit one row per date (Health
  // Connect) omit it; Withings/Oura set it so their unsorted per-reading rows fold
  // in chronological order. Never persisted.
  measured_at?: string;
  // The day is only PARTIALLY covered by this batch's rolling window (#606): its
  // body-fat / resting-HR day-averages were computed from a partial tail of the day's
  // samples, so they must not overwrite a fuller value stored when the day was wholly
  // in the window. Set by the Health Connect parser for the oldest day in a push.
  // Never persisted.
  partial_day?: boolean;
}

export interface NormMetricSample {
  metric: string; // 'steps','distance_km','active_kcal','total_kcal','hrv_ms'
  date: string; // YYYY-MM-DD in the profile timezone at ingest (#94); start_time is the natural key
  start_time: string; // absolute ISO instant; point records set start == end
  end_time: string;
  value: number;
}

// A pre-aggregated 1-minute heart-rate bucket from the incoming batch.
export interface NormHrMinute {
  ts: string; // 'YYYY-MM-DDTHH:MM' profile-local at ingest, no zone stored (#94)
  bpm: number; // average of this batch's samples in the minute
  bpm_min: number;
  bpm_max: number;
  n: number; // sample count in this batch
}

export interface NormActivity {
  external_id: string; // dedup key, e.g. 'health-connect:<start ISO>'
  date: string; // YYYY-MM-DD (local)
  type: ActivityType;
  title: string;
  duration_min: number | null;
  distance_km: number | null;
  start_time: string | null; // HH:MM
  end_time: string | null; // HH:MM
  // Richer per-activity metrics (Strava). All optional — a provider that omits a
  // field leaves the column null. Power/cadence/kilojoules are cycling-only,
  // avg_temp_c is outdoor-only, workout_type is a label (see strava.ts).
  avg_hr?: number | null;
  max_hr?: number | null;
  elevation_m?: number | null;
  avg_speed_kmh?: number | null;
  max_speed_kmh?: number | null;
  relative_effort?: number | null;
  avg_power_w?: number | null;
  max_power_w?: number | null;
  weighted_avg_power_w?: number | null;
  avg_cadence?: number | null;
  avg_temp_c?: number | null;
  kilojoules?: number | null;
  workout_type?: string | null;
  // Session effort level on the app's manual-entry scale ('easy' | 'moderate' |
  // 'hard'), the one column an integration can fill in activities.intensity (Oura
  // reports it directly). NULL for providers that don't supply it (Strava, Health
  // Connect) — see mapOuraWorkout.
  intensity?: string | null;
  // Structured components (e.g. a single canonical-sport entry for a Strava ride)
  // persisted to the activities.components JSON column. Cardio/sport summaries group
  // by component name (see effortEntries/getCardioByActivity), so a Strava row with a
  // "Cycling" component groups under Cycling even though its title is the athlete's
  // freeform name. Omitted/null for providers (Health Connect) that don't set it.
  components?: ActivityComponent[] | null;
}

// A GPS route for an activity → activity_routes (issue #569). Provider-agnostic:
// carries the encoded polyline as delivered plus optional start/end coordinates,
// keyed to its parent activity by `external_id` (resolved to the activity's DB id
// at upsert time). Source-owned and never hand-edited, so no edit-lock applies.
export interface NormActivityRoute {
  external_id: string; // the parent activity's external_id (dedup key)
  polyline: string; // Google encoded polyline, as delivered
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
}

// The extra metric columns NormActivity carries beyond the base fields, in a
// fixed order shared by the INSERT/UPDATE statements below. Kept in one place so
// the column list, placeholders, and bound values can't drift apart.
const ACTIVITY_METRIC_COLS = [
  "avg_hr",
  "max_hr",
  "elevation_m",
  "avg_speed_kmh",
  "max_speed_kmh",
  "relative_effort",
  "avg_power_w",
  "max_power_w",
  "weighted_avg_power_w",
  "avg_cadence",
  "avg_temp_c",
  "kilojoules",
  "workout_type",
  "intensity",
] as const;

function activityMetricValues(r: NormActivity): (number | string | null)[] {
  return ACTIVITY_METRIC_COLS.map((c) => r[c] ?? null);
}

// A clinical vital / biomarker reading → medical_records. canonical groups it with
// the same analyte from manual entry / documents; external_id dedups re-syncs.
export interface NormVital {
  external_id: string; // 'health-connect:<canonical>:<time>'
  date: string; // YYYY-MM-DD (local)
  category: "vitals" | "biomarker";
  name: string;
  canonical: string;
  value_num: number;
  unit: string;
}

export interface IngestCounts {
  bodyMetrics: number;
  samples: number;
  hrMinutes: number;
  activities: number;
  vitals: number;
}

// Upsert one imported body-metrics row per day, keyed by date + source. Only ever
// touches the row this source created — manually-entered rows (and rows from other
// sources) are never read or modified. Weight, body fat, and resting HR all live
// here now; a row may carry any subset (weight_kg is nullable). On update
// the incoming reading is folded into the stored row by mergeBodyMetric (pure,
// tested): a later sync window with only some of the three fills the gaps without
// blanking a value an earlier window stored, while a fresh non-null value (e.g. a
// corrected weight) still overwrites.
export function upsertBodyMetrics(
  profileId: number,
  rows: NormBodyMetric[],
  source: string
): UpsertCounts {
  // Pre-image on the (profile_id, date, source) natural key — now a DB UNIQUE index
  // (#133), which also lets the write below use ON CONFLICT DO UPDATE. `edited` is
  // the user-edit lock: a source-owned row the user has hand-edited (via the Review
  // resolver) is left alone on re-ingest so the rolling window never clobbers it.
  const find = db.prepare(
    "SELECT id, edited, weight_kg, body_fat_pct, resting_hr FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1"
  );
  // Atomic upsert on the unique key: the bound values are the RESOLVED post-image
  // (incoming for a fresh row, mergeBodyMetric(mine, incoming) for an existing one),
  // so `excluded.*` already carries the merged triple and DO UPDATE writes it.
  const upsert = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, date, source) DO UPDATE SET
       weight_kg = excluded.weight_kg,
       body_fat_pct = excluded.body_fat_pct,
       resting_hr = excluded.resting_hr`
  );

  // Re-import tombstones for body_metrics: a source-owned row the user merged away or
  // deleted must NOT be re-inserted by the rolling window (#507/#508). Loaded once.
  const tombstoned = loadImportTombstones(profileId, "body_metrics");
  const counts = emptyCounts();
  // Collapse multiple same-date readings in this batch to one row per date FIRST
  // (#605), so the stored triple is independent of the order the provider returned
  // its readings (Withings/Oura push one row per reading with no per-date collapse)
  // and a multi-weigh-in day no longer flip-flops on every re-scan.
  const collapsed = collapseBodyMetricsByDate(rows);
  for (const r of collapsed) {
    const incoming: BodyMetricValues = {
      weight_kg: r.weight_kg ?? null,
      body_fat_pct: r.body_fat_pct ?? null,
      resting_hr: r.resting_hr ?? null,
    };
    if (!hasBodyMetric(incoming)) continue; // nothing to store
    const mine = find.get(profileId, r.date, source) as
      (BodyMetricValues & { id: number; edited: number | null }) | undefined;
    // No live row AND a tombstone for this (date, source): the user removed it — skip
    // the re-insert and count it suppressed (a live row wins; the tombstone is stale).
    if (!mine && tombstoned.has(bodyMetricTombstoneKey(r.date, source))) {
      counts.suppressed++;
      continue;
    }
    // A hand-edited imported row is never overwritten; count it in its own `edited`
    // split (#659) — we deliberately persist nothing, but this is NOT an ordinary
    // no-op re-send, so it must be visible in Review rather than hidden in
    // `unchanged`. Mirrors the vitals + activities paths below.
    if (mine && isEditLocked(mine.edited)) {
      counts.edited++;
      continue;
    }
    // Resolved post-image: the merge fills gaps and lets a fresh non-null value
    // (a corrected weight) overwrite; a fresh row stores the incoming triple as-is.
    // On a partially-covered day (#606) the incoming body-fat/RHR "day average" was
    // computed from only a tail of the day's samples, so it must NOT overwrite a
    // fuller stored value — the partial-aware merge keeps the existing average there.
    const post = mine
      ? mergeBodyMetricPartialAware(mine, incoming, !!r.partial_day)
      : incoming;
    if (
      mine &&
      rowsEqual(
        BODY_METRIC_COMPARE_COLS,
        mine as unknown as Record<string, unknown>,
        post as unknown as Record<string, unknown>
      )
    ) {
      // A window that only re-states already-stored values is a no-op → unchanged;
      // skip the redundant write.
      counts.unchanged++;
      continue;
    }
    upsert.run(
      profileId,
      r.date,
      post.weight_kg,
      post.body_fat_pct,
      post.resting_hr,
      source
    );
    if (mine) counts.updated++;
    else counts.inserted++;
  }
  return counts;
}

const BODY_METRIC_COMPARE_COLS: string[] = [
  "weight_kg",
  "body_fat_pct",
  "resting_hr",
];

// Body-metric measures that live in body_metrics (weight_kg/body_fat_pct/
// resting_hr), NOT in metric_samples. A one-time fold moved body fat / resting
// HR out of metric_samples into body_metrics so every source of them shares one
// home; parsers route these to upsertBodyMetrics. This set is the guard (below)
// that keeps a future path from re-splitting them back into metric_samples, whose
// `metric` is free text. Kept as a plain array so callers/tests can reuse it.
export const BODY_METRIC_SAMPLE_MEASURES = [
  "body_fat_pct",
  "resting_hr",
] as const;

// Idempotent on (profile_id, metric, source, start_time, end_time): a resent
// record from the SAME source overwrites itself, but two DIFFERENT sources
// reporting the same metric for the same window each keep their own row —
// `source` is part of the unique key, so they no longer clobber each other.
//
// Guard: body fat % and resting HR belong in body_metrics, not
// here — see BODY_METRIC_SAMPLE_MEASURES. A row whose metric is one of those is a
// programming error (a parser mis-routing a body metric into the samples path), so
// it is skipped and NOT counted rather than re-splitting the measure across two
// tables.
export function upsertMetricSamples(
  profileId: number,
  rows: NormMetricSample[],
  source: string
): UpsertCounts {
  // Pre-image on the natural key the ON CONFLICT below merges on, so a re-send of
  // the rolling window that lands the same value/date is counted unchanged rather
  // than a write (info.changes can't see that the values matched).
  const find = db.prepare(
    "SELECT value, date FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ? AND start_time = ? AND end_time = ?"
  );
  const stmt = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, metric, source, start_time, end_time) DO UPDATE SET
       value = excluded.value, date = excluded.date`
  );
  // Re-import tombstones for metric_samples (#508): a user-deleted sample must not be
  // re-inserted by the rolling window. Loaded once for the batch.
  const tombstoned = loadImportTombstones(profileId, "metric_samples");
  const counts = emptyCounts();
  for (const r of rows) {
    if ((BODY_METRIC_SAMPLE_MEASURES as readonly string[]).includes(r.metric)) {
      // These belong in body_metrics (via upsertBodyMetrics); never let them land
      // in metric_samples and re-split the measure across two tables.
      continue;
    }
    const found = find.get(
      profileId,
      r.metric,
      source,
      r.start_time,
      r.end_time
    ) as { value: number; date: string } | undefined;
    // No live row AND a tombstone for this natural key: skip the resurrecting insert.
    if (
      !found &&
      tombstoned.has(
        metricSampleTombstoneKey(r.metric, source, r.start_time, r.end_time)
      )
    ) {
      counts.suppressed++;
      continue;
    }
    stmt.run(
      profileId,
      source,
      r.metric,
      r.date,
      r.start_time,
      r.end_time,
      r.value
    );
    if (!found) counts.inserted++;
    else if (found.value === r.value && found.date === r.date)
      counts.unchanged++;
    else counts.updated++;
  }
  return counts;
}

// Replace the minute bucket for each `ts` outright. Each exporter push recomputes
// every 1-minute aggregate from that batch's raw samples, so the incoming row is
// already the authoritative value for its minute — merging by count-weighted
// average would double `n` (and freeze the average) on every resend of the rolling
// 48h window. REPLACE-by-key keeps re-ingest idempotent. The key is
// (profile_id, ts, source) — migration 013, issue #14 — so a resend from the SAME
// source replaces its own bucket while two different sources reporting the same
// minute coexist instead of clobbering each other.
export function upsertHrMinutes(
  profileId: number,
  rows: NormHrMinute[],
  source: string
): UpsertCounts {
  // Pre-image on (profile_id, ts, source): the exporter recomputes each minute
  // bucket from that batch's raw samples and replaces the row outright, so a
  // resend of an identical minute (same bpm/min/max/n) is unchanged, not a write.
  const find = db.prepare(
    "SELECT bpm, bpm_min, bpm_max, n FROM hr_minutes WHERE profile_id = ? AND ts = ? AND source = ?"
  );
  const stmt = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, ts, source) DO UPDATE SET
       bpm = excluded.bpm, bpm_min = excluded.bpm_min, bpm_max = excluded.bpm_max,
       n = excluded.n`
  );
  // No re-import tombstone consult here (#653): hr_minutes has no per-row delete path
  // (browse/export-only dataset; the only non-sync mutation is the timezone re-import
  // sweep, which must re-insert), so there is nothing for a sync to resurrect and the
  // table is intentionally absent from TOMBSTONE_TABLES.
  const counts = emptyCounts();
  for (const r of rows) {
    const found = find.get(profileId, r.ts, source) as
      | {
          bpm: number;
          bpm_min: number;
          bpm_max: number;
          n: number;
        }
      | undefined;
    stmt.run(profileId, r.ts, r.bpm, r.bpm_min, r.bpm_max, r.n, source);
    if (!found) counts.inserted++;
    else if (
      found.bpm === r.bpm &&
      found.bpm_min === r.bpm_min &&
      found.bpm_max === r.bpm_max &&
      found.n === r.n
    )
      counts.unchanged++;
    else counts.updated++;
  }
  return counts;
}

// Insert or update a vital/biomarker reading into medical_records, deduped on
// external_id. Only ever touches rows this source created (external_id is NULL for
// manual + document-extracted rows). Returns the affected row ids so the caller can
// run reconcileFlags() to set out-of-range flags. `value` mirrors value_num as text
// (the medical UI shows `value`).
const VITAL_COMPARE_COLS: string[] = [
  "date",
  "category",
  "name",
  "value",
  "value_num",
  "unit",
  "canonical_name",
];

export function upsertVitals(
  profileId: number,
  rows: NormVital[],
  source: string
): { ids: number[]; counts: UpsertCounts } {
  const find = db.prepare(
    `SELECT id, edited, date, category, name, value, value_num, unit, canonical_name
       FROM medical_records WHERE profile_id = ? AND external_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE medical_records
       SET date = ?, category = ?, name = ?, value = ?, value_num = ?, unit = ?,
           canonical_name = ?
     WHERE id = ?`
  );
  // Re-import tombstones for medical_records vitals (#508), keyed by external_id.
  const tombstoned = loadImportTombstones(profileId, "medical_records");
  const ids: number[] = [];
  const counts = emptyCounts();
  for (const r of rows) {
    const valueStr = String(r.value_num);
    const found = find.get(profileId, r.external_id) as
      | (Record<string, unknown> & { id: number; edited: number | null })
      | undefined;
    // A hand-edited imported vital is never clobbered by re-ingest. Count it in the
    // `edited` split (#659) — we persist nothing — and, unlike the value-matched
    // unchanged case, do NOT push its id: the row is left entirely untouched, no flag
    // re-derivation.
    if (found && isEditLocked(found.edited)) {
      counts.edited++;
      continue;
    }
    // No live row AND a tombstone for this external_id: the user deleted this vital —
    // skip the resurrecting insert and count it suppressed.
    if (!found && tombstoned.has(r.external_id)) {
      counts.suppressed++;
      continue;
    }
    if (found) {
      // Resolved post-image (note the incoming `canonical` maps to the stored
      // `canonical_name` column). The `flag` column isn't compared: it's set out
      // of band by reconcileFlags, not by this write.
      const post = {
        date: r.date,
        category: r.category,
        name: r.name,
        value: valueStr,
        value_num: r.value_num,
        unit: r.unit,
        canonical_name: r.canonical,
      };
      if (rowsEqual(VITAL_COMPARE_COLS, found, post)) {
        counts.unchanged++;
      } else {
        update.run(
          r.date,
          r.category,
          r.name,
          valueStr,
          r.value_num,
          r.unit,
          r.canonical,
          found.id
        );
        counts.updated++;
      }
      ids.push(found.id);
    } else {
      const info = insert.run(
        profileId,
        r.date,
        r.category,
        r.name,
        valueStr,
        r.value_num,
        r.unit,
        r.canonical,
        source,
        r.external_id
      );
      ids.push(Number(info.lastInsertRowid));
      counts.inserted++;
    }
  }
  return { ids, counts };
}

// Insert or update an activity, deduped on external_id (synthesized from the
// session start). Preserves the activity's id (and its notes/components) on update.
// The base (non-metric) columns the activity upsert writes, compared alongside
// ACTIVITY_METRIC_COLS to decide unchanged-vs-updated on re-ingest.
const ACTIVITY_BASE_COLS = [
  "date",
  "type",
  "title",
  "duration_min",
  "distance_km",
  "start_time",
  "end_time",
  "source",
];

export function upsertActivities(
  profileId: number,
  rows: NormActivity[],
  source: string
): UpsertCounts {
  const metricCols = ACTIVITY_METRIC_COLS.join(", ");
  const metricSet = ACTIVITY_METRIC_COLS.map((c) => `${c} = ?`).join(", ");
  const metricPlaceholders = ACTIVITY_METRIC_COLS.map(() => "?").join(", ");
  // `components` is a JSON string column, compared alongside the base/metric cols so
  // a components change → updated and an identical re-sync (same serialized JSON) →
  // unchanged. Providers that omit components store/compare null on both sides.
  const compareCols = [
    ...ACTIVITY_BASE_COLS,
    ...ACTIVITY_METRIC_COLS,
    "components",
  ];
  const find = db.prepare(
    `SELECT id, edited, date, type, title, duration_min, distance_km,
            start_time, end_time, source, components, ${metricCols}
       FROM activities WHERE profile_id = ? AND external_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, start_time, end_time, ${metricCols}, components, source, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${metricPlaceholders}, ?, ?, ?)`
  );
  // NOTE (#342): equipment_id is deliberately absent from BOTH this UPDATE's column
  // set and the compareCols above, so a re-sync never clobbers a hand-set session
  // gear link — the picker is app-only, providers don't supply it. A user who links
  // gear on an imported row also flips `edited` (saveActivity), so the found.edited
  // guard below already short-circuits the whole write; this keeps it safe even if
  // that lock ever changed. Keep equipment_id out of the sync footprint.
  const update = db.prepare(
    `UPDATE activities
       SET date = ?, type = ?, title = ?, duration_min = ?, distance_km = ?,
           start_time = ?, end_time = ?, ${metricSet}, components = ?, source = ?
     WHERE id = ?`
  );
  // Re-import tombstones for activities (#507/#508), keyed by external_id. A row the
  // user merged away or deleted must not be re-inserted by the trailing re-scan.
  const tombstoned = loadImportTombstones(profileId, "activities");
  const counts = emptyCounts();
  for (const r of rows) {
    const metrics = activityMetricValues(r);
    // Serialize components to the JSON string actually stored, so the pre-image
    // compare below matches the column value byte-for-byte on an identical re-sync.
    const componentsJson =
      r.components && r.components.length ? JSON.stringify(r.components) : null;
    const found = find.get(profileId, r.external_id) as
      | (Record<string, unknown> & { id: number; edited: number | null })
      | undefined;
    // A source-owned row the user has hand-edited is left alone on re-ingest, so
    // the rolling 48h/re-scan window never clobbers those edits. Counts in the
    // `edited` split (#659) — we deliberately persist nothing, but this is a lock
    // the user should be able to see in Review, not a silent no-op.
    if (found && found.edited) {
      counts.edited++;
      continue;
    }
    if (found) {
      // Resolved post-image over the same columns the UPDATE writes (metric fields
      // reuse activityMetricValues so the compare and the write can't drift).
      const post: Record<string, unknown> = {
        date: r.date,
        type: r.type,
        title: r.title,
        duration_min: r.duration_min,
        distance_km: r.distance_km,
        start_time: r.start_time,
        end_time: r.end_time,
        source,
        components: componentsJson,
      };
      ACTIVITY_METRIC_COLS.forEach((c, i) => {
        post[c] = metrics[i];
      });
      if (rowsEqual(compareCols, found, post)) {
        counts.unchanged++;
      } else {
        update.run(
          r.date,
          r.type,
          r.title,
          r.duration_min,
          r.distance_km,
          r.start_time,
          r.end_time,
          ...metrics,
          componentsJson,
          source,
          found.id
        );
        counts.updated++;
      }
    } else if (tombstoned.has(r.external_id)) {
      // No live row AND a tombstone for this external_id: the user merged/deleted it —
      // skip the resurrecting insert and count it suppressed.
      counts.suppressed++;
      continue;
    } else {
      insert.run(
        profileId,
        r.date,
        r.type,
        r.title,
        r.duration_min,
        r.distance_km,
        r.start_time,
        r.end_time,
        ...metrics,
        componentsJson,
        source,
        r.external_id
      );
      counts.inserted++;
    }
  }
  return counts;
}

// Upsert activity GPS routes into the activity_routes child table (issue #569),
// keyed 1:1 on the parent activity by activity_id (UNIQUE). Each incoming route
// carries its parent's `external_id`; we resolve that to the activity's DB id with
// a PROFILE-SCOPED SELECT (so the write can never reach across profiles) and skip a
// route whose parent activity doesn't exist — e.g. one that was tombstoned/skipped
// by upsertActivities this same run. Routes are source-owned and never hand-edited,
// so there's no edit-lock/tombstone path here; the ON CONFLICT keeps re-syncs
// idempotent, and a SELECT-before-compare counts an unchanged polyline as unchanged
// rather than a write. Call it AFTER upsertActivities in the same writeTx.
export function upsertActivityRoutes(
  profileId: number,
  rows: NormActivityRoute[],
  source: string
): UpsertCounts {
  const findActivity = db.prepare(
    "SELECT id FROM activities WHERE profile_id = ? AND external_id = ?"
  );
  const findRoute = db.prepare(
    "SELECT polyline, start_lat, start_lng, end_lat, end_lng FROM activity_routes WHERE activity_id = ?"
  );
  const upsert = db.prepare(
    `INSERT INTO activity_routes
       (activity_id, polyline, start_lat, start_lng, end_lat, end_lng, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(activity_id) DO UPDATE SET
       polyline = excluded.polyline,
       start_lat = excluded.start_lat, start_lng = excluded.start_lng,
       end_lat = excluded.end_lat, end_lng = excluded.end_lng,
       source = excluded.source`
  );
  const counts = emptyCounts();
  for (const r of rows) {
    if (!r.polyline) continue;
    const act = findActivity.get(profileId, r.external_id) as
      { id: number } | undefined;
    if (!act) continue; // parent skipped/tombstoned this run — no orphan route
    const found = findRoute.get(act.id) as
      | {
          polyline: string;
          start_lat: number | null;
          start_lng: number | null;
          end_lat: number | null;
          end_lng: number | null;
        }
      | undefined;
    if (
      found &&
      found.polyline === r.polyline &&
      found.start_lat === r.start_lat &&
      found.start_lng === r.start_lng &&
      found.end_lat === r.end_lat &&
      found.end_lng === r.end_lng
    ) {
      counts.unchanged++;
      continue;
    }
    upsert.run(
      act.id,
      r.polyline,
      r.start_lat,
      r.start_lng,
      r.end_lat,
      r.end_lng,
      source
    );
    if (found) counts.updated++;
    else counts.inserted++;
  }
  return counts;
}
