import { db } from "@/lib/db";
import { IMPORTED } from "../logged-via";
import { sqlNow } from "@/lib/clock";
import type { ActivityType, ActivityComponent, MedicalFlag } from "@/lib/types";
import {
  normalizeResultStatus,
  supersedesReading,
} from "@/lib/lab-result-lifecycle";
import { insertObservationRevision } from "@/lib/queries/medical/revisions";
import {
  hasBodyMetric,
  mergeBodyMetricPartialAware,
  mergeMeasureInstants,
  type BodyMetricInstants,
  type BodyMetricValues,
} from "@/lib/body-metric-extract";
import { collapseBodyMetricsByDate } from "./body-metric-collapse";
import type { Kg, Km } from "@/lib/units";
import {
  emptyCounts,
  rowsEqual,
  isEditLocked,
  classifyUpsert,
  tallyUpsert,
} from "./sync-log";
import type { UpsertCounts, SyncRowSink } from "./sync-log";
import { loadImportTombstones } from "./tombstones";
import {
  bodyMetricTombstoneKey,
  metricSampleTombstoneKey,
} from "./tombstone-keys";
import { isStaleMetricSnapshot } from "@/lib/metric-snapshot";
import {
  anchorRefusesDay,
  compareWindowStarts,
  isSupersedingWindow,
  planSupersede,
  windowsOverlap,
  type MetricWindow,
  type UnstampedEra,
} from "@/lib/metric-window-overlap";
import { readUnstampedEra } from "./unstamped-era";
import { HEALTH_CONNECT_ID } from "./health-connect";
import { streamKeysPlacedIn } from "@/lib/reading-placement";

// Source-agnostic record shapes. Every integration parses its own payload into
// these, then calls the shared upserts below — so a new source (Strava, Garmin)
// reuses all of the DB mapping and idempotency logic.

// Per-day body metrics. weight_kg may be undefined (e.g. a body-fat-only day).
//
// `weight_kg` is BRANDED (#2149): the column stores kilograms, so a parser must state
// the unit its source reported in by minting through `toKg` — `toKg(lbs, "lb")` for
// a source that reports pounds, `toKg(v, "kg")` for one that already reports the
// canonical unit. A raw `number` no longer compiles here, which is what stops a
// display-unit or wrong-unit payload from reaching `body_metrics.weight_kg`.
export interface NormBodyMetric {
  date: string; // YYYY-MM-DD (local)
  weight_kg?: Kg;
  body_fat_pct?: number;
  resting_hr?: number;
  // The absolute instant (ISO) this reading was taken. Only used to collapse multiple
  // same-date readings within a batch deterministically (#605) — the LATEST non-null
  // value wins per field. Sources that already emit one row per date (Health
  // Connect) omit it; Withings/Oura set it so their unsorted per-reading rows fold
  // in chronological order. Never persisted.
  measured_at?: string;
  // THE INSTANT EACH MEASURE WAS TAKEN, per measure, ISO (#3524). Deliberately not one
  // field: `body_metrics` is one WIDE row per day carrying up to
  // three measures, and one column cannot hold three instants — that is exactly the
  // mistake that made an earlier draft of the ingest reconcile destroy a weigh-in while
  // re-keying a resting-HR reading. The ingest reconcile
  // (lib/integrations/ingest-timezone-reconcile.ts) asks the day arithmetic about ONE
  // measure at a time and clears ONE column, so it needs the instant that measure
  // actually carries. Health Connect sets these; nothing else needs to, because a
  // profile-timezone change does not re-key a source that attributes readings in the
  // DEVICE's zone.
  //
  // NOW PERSISTED, per the owner's 2026-08-29 ruling on #3950: `body_metrics` gained
  // `weight_at` / `body_fat_at` / `resting_hr_at`, nullable, day-grain key untouched. A
  // source that states no per-measure instant honestly stores NULL.
  weight_at?: string;
  body_fat_at?: string;
  resting_hr_at?: string;
  // The day is only PARTIALLY covered by this batch's rolling window (#606): its
  // body-fat / resting-HR day-averages were computed from a partial tail of the day's
  // samples, so they must not overwrite a fuller value stored when the day was wholly
  // in the window. Set by the Health Connect parser for the oldest day in a push.
  // Never persisted.
  partial_day?: boolean;
}

export interface NormMetricSample {
  metric: string; // 'steps','distance_km','active_kcal','total_kcal','hrv_ms'
  date: string; // YYYY-MM-DD in the profile timezone at ingest (#94); started_at is the natural key
  started_at: string; // absolute ISO instant; point records set start == end
  ended_at: string;
  value: number;
  // Source-within-source provenance. Health Connect can carry records from
  // several origin apps (for example Fitbit and Garmin) under the single
  // `health-connect` integration source. Other integrations omit it.
  origin?: string | null;
  // Stable identity of the imported activity this sample describes. Unlike the
  // sample window, this survives user edits to the activity's date/clock fields.
  // Null/omitted for standalone metrics (steps, sleep, daily energy, etc.).
  activity_external_id?: string | null;
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
  // BRANDED (#2149), for the same reason as NormBodyMetric.weight_kg: sources report
  // distance in metres (Strava), miles, or kilometres, and `activities.distance_km`
  // stores kilometres. A parser states which by minting through `toKm`.
  distance_km: Km | null;
  start_time: string | null; // HH:MM
  end_time: string | null; // HH:MM
  // Richer per-activity metrics (Strava). All optional — a source that omits a
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
  // reports it directly). NULL for sources that don't supply it (Strava, Health
  // Connect) — see mapOuraWorkout.
  intensity?: string | null;
  // Structured components (e.g. a single canonical-sport entry for a Strava ride)
  // persisted to the activities.components JSON column. Cardio/sport summaries group
  // by component name (see effortEntries/getCardioByActivity), so a Strava row with a
  // "Cycling" component groups under Cycling even though its title is the athlete's
  // freeform name. Omitted/null for sources (Health Connect) that don't set it.
  components?: ActivityComponent[] | null;
}

// A source-owned wellness-practice session. Unlike training activities, practices
// live in their own ledger and carry no exercise type, distance, sets, or components.
export interface NormPracticeLog {
  external_id: string;
  practice: string;
  date: string;
  // The session's START (#3142). Every source that sets it already means a start —
  // the Fitbit takeout maps `log.startTime` here — so the rename made the field
  // honest rather than changing any value. No source states an END: `end_time` stays
  // NULL on imported rows and `activityWindow` derives the end from `duration_min`.
  start_time: string | null;
  duration_min: number | null;
}

export function upsertPracticeLogs(
  profileId: number,
  rows: NormPracticeLog[],
  source: string,
  sink?: SyncRowSink
): UpsertCounts {
  // The RENAMED column is in the compare set (#3142), so a re-import of an unchanged
  // session still classifies as `unchanged`. `end_time` is deliberately absent: no
  // source states one, so it is not a column this upsert owns and comparing it would
  // be a claim about a value the importer never writes.
  const compareCols = [
    "practice",
    "date",
    "start_time",
    "duration_min",
    "source",
  ];
  const find = db.prepare(
    `SELECT id, edited, practice, date, start_time, duration_min, source
       FROM practice_logs WHERE profile_id = ? AND external_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO practice_logs
       (profile_id, practice, date, start_time, duration_min, source,
        external_id, logged_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE practice_logs
        SET practice = ?, date = ?, start_time = ?, duration_min = ?, source = ?
      WHERE id = ? AND profile_id = ?`
  );
  // Fitbit meditations originally landed in activities. Migration 118 moves the
  // untouched rows, but deliberately leaves a user-edited/attached activity in
  // place. Preserve that cross-table occupancy on every later re-import so the same
  // source record cannot also appear as a practice.
  const findLegacyActivity = db.prepare(
    `SELECT edited FROM activities
      WHERE profile_id = ? AND external_id = ?`
  );
  const tombstoned = loadImportTombstones(profileId, "practice_logs");
  // A meditation deleted before migration 118 has its suppression recorded against
  // the old target table. The source identity did not change when its destination
  // did, so that deletion must continue to suppress the rerouted practice.
  const legacyActivityTombstones = loadImportTombstones(
    profileId,
    "activities"
  );
  const counts = emptyCounts();

  for (const row of rows) {
    const found = find.get(profileId, row.external_id) as
      | (Record<string, unknown> & { id: number; edited: number | null })
      | undefined;
    if (found && isEditLocked(found.edited)) {
      counts.edited++;
      continue;
    }
    if (found) {
      const post: Record<string, unknown> = {
        practice: row.practice,
        date: row.date,
        start_time: row.start_time,
        duration_min: row.duration_min,
        source,
      };
      const disposition = classifyUpsert(
        true,
        rowsEqual(compareCols, found, post)
      );
      if (disposition === "updated") {
        update.run(
          row.practice,
          row.date,
          row.start_time,
          row.duration_min,
          source,
          found.id,
          profileId
        );
        sink?.push({
          target_table: "practice_logs",
          target_id: found.id,
          disposition,
        });
      }
      tallyUpsert(counts, disposition);
    } else if (
      tombstoned.has(row.external_id) ||
      legacyActivityTombstones.has(row.external_id)
    ) {
      counts.suppressed++;
    } else {
      const legacyActivity = findLegacyActivity.get(
        profileId,
        row.external_id
      ) as { edited: number | null } | undefined;
      if (legacyActivity) {
        if (isEditLocked(legacyActivity.edited)) counts.edited++;
        else counts.suppressed++;
        continue;
      }
      const info = insert.run(
        profileId,
        row.practice,
        row.date,
        row.start_time,
        row.duration_min,
        source,
        row.external_id,
        IMPORTED
      );
      const disposition = classifyUpsert(false, false);
      tallyUpsert(counts, disposition);
      sink?.push({
        target_table: "practice_logs",
        target_id: Number(info.lastInsertRowid),
        disposition: "inserted",
      });
    }
  }
  return counts;
}

// A GPS route for an activity → activity_routes (issue #569). Source-agnostic:
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

// A clinical vital / lab reading → medical_records. canonical groups it with
// the same analyte from manual entry / documents; external_id dedups re-syncs.
export interface NormVital {
  external_id: string; // 'health-connect:<canonical>:<time>'
  date: string; // YYYY-MM-DD (local)
  // The instant the reading was taken, canonical UTC (`utcInstant` shape) —
  // destined for medical_records.occurred_at (#2154). The parsers were already
  // encoding this moment into `external_id`; now it is queryable data too.
  // `external_id` STAYS the dedupe key, unchanged — occurred_at is descriptive,
  // never identity. Absent/null for a source whose reading is a DAILY AGGREGATE
  // (Fitbit Takeout's daily SpO₂/respiratory files): a vendor day-summary has no
  // event instant, and NULL is the honest day-grain answer.
  occurred_at?: string | null;
  // #2479 part 2: `biomarker` is GONE from this union, not merely unused. It was the
  // legacy catch-all, and a source writing it (VO2 Max did, from Health Connect and
  // Withings) refilled the very bucket migration 185 empties. The narrowing is the
  // guard: a parser that reaches for it no longer compiles.
  category: "vitals" | "lab";
  name: string;
  canonical: string;
  value_num: number;
  unit: string;
  // The result's place in the lab lifecycle when the SOURCE states one (#1404) —
  // FHIR `Observation.status`: preliminary / final / corrected / amended. Optional:
  // a device/vitals feed states nothing, which stays NULL ("unstated"), never a
  // guessed 'final'. A source that re-issues a value as 'corrected' makes the
  // supersession explicit rather than leaving it to be inferred from the diff.
  result_status?: string | null;
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
  source: string,
  sink?: SyncRowSink
): UpsertCounts {
  // Pre-image on the (profile_id, date, source) natural key — now a DB UNIQUE index
  // (#133), which also lets the write below use ON CONFLICT DO UPDATE. `edited` is
  // the user-edit lock: a source-owned row the user has hand-edited (via the Review
  // resolver) is left alone on re-ingest so the rolling window never clobbers it.
  const find = db.prepare(
    `SELECT id, edited, weight_kg, body_fat_pct, resting_hr,
            weight_at, body_fat_at, resting_hr_at
       FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?
      ORDER BY id LIMIT 1`
  );
  // Atomic upsert on the unique key: the bound values are the RESOLVED post-image
  // (incoming for a fresh row, mergeBodyMetric(mine, incoming) for an existing one),
  // so `excluded.*` already carries the merged triple and DO UPDATE writes it.
  const upsert = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr,
       weight_at, body_fat_at, resting_hr_at, source, logged_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, date, source) DO UPDATE SET
       weight_kg = excluded.weight_kg,
       body_fat_pct = excluded.body_fat_pct,
       resting_hr = excluded.resting_hr,
       weight_at = excluded.weight_at,
       body_fat_at = excluded.body_fat_at,
       resting_hr_at = excluded.resting_hr_at`
  );

  // Re-import tombstones for body_metrics: a source-owned row the user merged away or
  // deleted must NOT be re-inserted by the rolling window (#507/#508). Loaded once.
  const tombstoned = loadImportTombstones(profileId, "body_metrics");
  const counts = emptyCounts();
  // Collapse multiple same-date readings in this batch to one row per date FIRST
  // (#605), so the stored triple is independent of the order the source returned
  // its readings (Withings/Oura push one row per reading with no per-date collapse)
  // and a multi-weigh-in day no longer flip-flops on every re-scan.
  const collapsed = collapseBodyMetricsByDate(rows);
  for (const r of collapsed) {
    // The three measures and the three instants travel together from here on: an
    // instant that got decided apart from its own measure would describe the reading
    // that LOST the merge (#3950). `mergeMeasureInstants` applies the same rule.
    const incoming: BodyMetricValues & BodyMetricInstants = {
      weight_kg: r.weight_kg ?? null,
      body_fat_pct: r.body_fat_pct ?? null,
      resting_hr: r.resting_hr ?? null,
      weight_at: r.weight_at ?? null,
      body_fat_at: r.body_fat_at ?? null,
      resting_hr_at: r.resting_hr_at ?? null,
    };
    if (!hasBodyMetric(incoming)) continue; // nothing to store
    const mine = find.get(profileId, r.date, source) as
      | (BodyMetricValues &
          BodyMetricInstants & { id: number; edited: number | null })
      | undefined;
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
    const postAt: BodyMetricInstants = mine
      ? mergeMeasureInstants(mine, incoming, !!r.partial_day)
      : incoming;
    const equal =
      !!mine &&
      rowsEqual(
        BODY_METRIC_COMPARE_COLS,
        mine as unknown as Record<string, unknown>,
        { ...post, ...postAt } as unknown as Record<string, unknown>
      );
    const disposition = classifyUpsert(!!mine, equal);
    if (disposition === "unchanged") {
      // A window that only re-states already-stored values is a no-op → unchanged;
      // skip the redundant write.
      tallyUpsert(counts, disposition);
      continue;
    }
    const info = upsert.run(
      profileId,
      r.date,
      post.weight_kg,
      post.body_fat_pct,
      post.resting_hr,
      postAt.weight_at,
      postAt.body_fat_at,
      postAt.resting_hr_at,
      source,
      IMPORTED
    );
    tallyUpsert(counts, disposition);
    // Per-row provenance (#1333): the affected row id is the pre-image row's id on an
    // update, else the freshly-inserted rowid. Only inserted/updated reach here.
    sink?.push({
      target_table: "body_metrics",
      target_id: mine ? mine.id : Number(info.lastInsertRowid),
      disposition,
    });
  }
  return counts;
}

// What makes a re-send a NO-OP — and the instants ARE part of it, which is not
// obvious. A row stored before #3950 carries the right weight and a NULL `weight_at`;
// the exporter's rolling window then re-sends that same weight WITH its instant. On
// the three measures alone that reads as `unchanged`, the write is skipped, and the
// instant the source has just handed us is dropped on the floor — the ordinary
// re-send is exactly how already-stored days acquire their instants, so leaving these
// out would silently disable it. The cost is one Review line per re-sent day the first
// time the window covers it after this lands, and that line is honest: the row gained
// a fact it did not have.
const BODY_METRIC_COMPARE_COLS: string[] = [
  "weight_kg",
  "body_fat_pct",
  "resting_hr",
  "weight_at",
  "body_fat_at",
  "resting_hr_at",
];

// Body-metric measures that live in body_metrics (body_fat_pct/resting_hr), NOT in
// metric_samples. A one-time fold moved body fat / resting HR out of metric_samples into
// body_metrics so every source of them shares one home; parsers route these to
// upsertBodyMetrics. This set is the guard (below) that keeps a future path from
// re-splitting them back into metric_samples, whose `metric` is free text.
//
// DERIVED FROM THE PLACEMENT POLICY (#2032), not hand-kept beside it. These are exactly
// the stream keys a registered reading identity places in `body_metrics`, so the guard
// and the write core cannot come to disagree about where a quantity belongs — which is
// the whole failure this sweep exists to catch, one layer up.
export const BODY_METRIC_SAMPLE_MEASURES: readonly string[] =
  streamKeysPlacedIn("body_metrics");

// THE SOURCE WHOSE INTERVAL ROWS SUPERSEDE WHAT THEY OVERLAP (#3424).
//
// Health Connect is the ONE source whose day-buckets re-anchor under the app's feet:
// the exporter follows the DEVICE zone, so a timezone change re-cuts "today" and the
// re-anchored record arrives with a start the natural key has never seen (see
// lib/metric-window-overlap.ts for the whole mechanism). Withings, Oura, Strava and
// the Fitbit takeout attribute each reading on their own clock and re-send the same
// key, and manual readings are the user's own rows — none of them may ever have a row
// deleted by this path, which is why the rule is gated on the source id rather than on
// a shape test that a future source could accidentally match.
const OVERLAP_SUPERSEDE_SOURCE = HEALTH_CONNECT_ID;

// Idempotent on (profile_id, metric, source, origin, started_at): a resent
// record from the SAME source overwrites itself, but two DIFFERENT sources
// (or two origins inside Health Connect) each keep their own row. `ended_at` is
// deliberately mutable: daily cumulative exporter snapshots keep a stable start
// while their end advances to the push moment (#1101).
//
// AND, FOR HEALTH CONNECT ONLY, the stored rows a push's windows overlap are DELETED
// AFTER it is written (#3424). That is what the start-keyed idempotency of #1101 cannot
// do: a moving END overwrites its own key, a moving START mints a new one and leaves the
// old row summing into the same profile-local day. Edit-locked rows survive it,
// tombstoned rows stay dead, and point readings are untouched.
//
// THAT DELETE DOES NOT HAPPEN IN THIS FUNCTION. The victim set is derived from the STORE,
// in the LAST chunk's transaction and after that chunk's upserts have run, by
// `supersedeMetricSampleOverlaps` below — whose header carries the argument. All this
// function does for the rule is write `pushed_at`, which is what makes a row of this push
// visible to that derivation.
//
// Guard: body fat % and resting HR belong in body_metrics, not
// here — see BODY_METRIC_SAMPLE_MEASURES. A row whose metric is one of those is a
// programming error (a parser mis-routing a body metric into the samples path), so
// it is skipped and NOT counted rather than re-splitting the measure across two
// tables.
export interface MetricSampleUpsertOptions {
  /**
   * The exporter's stamp on this push (`ParsedPayload.pushedAt`). Stored on every row
   * written and required before any row may supersede another (#3424): without it the
   * rule falls back on arrival order, which an exporter retry defeats.
   */
  pushedAt?: string | null;
}

// ── THE OVERLAP-SUPERSEDE, IN TWO PHASES (#3424) ──────────────────────────────────
//
// C  upsertMetricSamples            the upsert loop, with no supersede in it at all
// B  supersedeMetricSampleOverlaps  the victim set DERIVED FROM THE STORE and deleted —
//                                   inside the LAST chunk's IMMEDIATE transaction,
//                                   AFTER that chunk's upserts have run
//
// THERE IS NO PASS A ANY MORE, AND ITS ABSENCE IS THE FIX. Nine adversarial rounds paid
// for that sentence, so it is worth saying what was there and why it went.
//
// The rule used to run per row inside the upsert loop: find the overlaps, delete them,
// upsert. That loop has TWO mutation paths — the per-row DELETE and the per-key
// ON CONFLICT — and one pre-image read, `found`, the natural-key twin #1101's moving-END
// merge needs, so a delete for one row changed what a LATER row of the same push read.
// Rounds 1 and 5 reached that through two different doors and measured the same push
// storing 11609 or 22609 depending only on where the chunk boundary fell.
//
// The first ruling (#3424, option 2) answered it with a read-only PLAN over the payload,
// computed before any row was written. That killed rounds 1/2/3/5 structurally. It also
// created a new class, and rounds 7, 8 and 9 are all of it:
//
//     pass A reads a fact, pass B acts on it later, and in between a veto fires
//     (tombstone, edit-lock) or a writer moves the fact (`updateReadingAt`).
//
// Round 7 was the in-process version — a fact pass A never asked (the #508 tombstone
// refused the row whose landing licensed a delete, and the day went to ZERO). Rounds 8
// and 9 were the cross-process version — a fact pass A DID ask and a writer moved
// (Data → Manage deleting the replacement; the trends detail page's per-row Edit arming
// `edited` on the victim). Each fix was another re-statement clause in the DELETE, and
// the argument for "this is the last one" became a ten-row table. That is option 1 at
// the guard level, over a construction that keeps producing them.
//
// THE OWNER CLOSED THE CLASS INSTEAD (#3424, the ruling of 2026-08-22T13:46Z), and then
// FIXED ITS UNIT (the ruling of 2026-08-23T00:58Z, after round 10 refuted the first
// spelling by emptying a day with it):
//
//     a stored day-bucket row of (profile, metric, source = HC, origin) is a victim iff,
//     UNDER THE LOCK RIGHT NOW: a row of the same group carrying THIS PUSH'S STAMP is
//     FILED UNDER THE VICTIM'S OWN `date` and overlaps it; its own stamp is older or
//     NULL-in-era; `edited = 0`; its key is not one this push wrote. Delete exactly
//     those, in the same transaction.
//
// COVER THE DAY. The `date` term is the ruling and the rest of this comment is what it
// replaced: overlap ALONE let the PREVIOUS day's re-anchored bucket justify a delete on
// a day this push never replaced, because day buckets chain across days by the zone
// offset — so a tombstoned or stale-retried replacement stopped its own row and the day
// still went to ZERO. Overlap stays as a gate (it excludes the rollover pair and the
// same-anchoring neighbours); the date carries the justification. The argument, the two
// rejected alternatives and the loss this accepts are in lib/metric-window-overlap.ts's
// header; what belongs HERE is that it costs one term on the query below and nothing
// else — no payload, no second pass, no re-statement clause.
//
// NOTHING ABOUT THE PAYLOAD ENTERS THE PLAN. The justification for a delete is a row that
// IS IN THE STORE WITH THIS PUSH'S STAMP — which is true precisely when pass C let it
// land, because every upsert that runs sets `pushed_at` to the stamp (`unchanged`
// included) and a tombstoned, mis-routed, edit-locked or stale-retry row never gets the
// stamp onto a row that could justify anything. So the four vetoes become STRUCTURALLY
// VISIBLE without being enumerated:
//
//   • a suppressed replacement justifies nothing ON ITS OWN DATE (round 7) — and under
//     cover-the-day it justifies nothing on any OTHER date either, which is round 10
//   • an edit-lock on a NARROW twin leaves no stamped DAY BUCKET overlapping the victim,
//     so the wide bucket is not collapsed on the strength of a fifteen-minute row
//                                                             (round 9b)
//   • `edited`, `pushed_at` and the overlap are read UNDER THE LOCK, where `writeTx` is
//     `.immediate()` and no other writer can move them        (rounds 8, 9a)
//
// A FIFTH VETO COSTS NOTHING HERE, which is the property that matters rather than the
// four instances: this file never asks why a row was refused, only whether the store
// holds it with this push's stamp. Adding a veto still costs a `MetricSampleVeto` member
// and its `VETO_TALLY` entry, because Review has to say what happened to the row.
//
// WHAT THE CLASS-CLOSING COSTS, AND IT IS PAID DELIBERATELY. A push EVERY row of which is
// vetoed stamps nothing, so it derives no victims — right — and also reports no overlaps
// left standing, where the payload-side plan used to report the vetoed row's stored twin.
// The store may genuinely hold two overlapping rows there. Naming them means asking "do
// two STORED rows overlap each other", which is a different scan with a different unit,
// would change the Review line on every push rather than on this one, and is the question
// this file has always declined (see `supersedeMetricSampleOverlaps`). A push that landed
// nothing says nothing.
//
// THE CORRECTNESS ARGUMENT IS THEN TWO LINES:
//
//     final store = (store after ⊕ upserts) − victims
//     victims     = a pure function of THE STORE, read in the transaction that deletes it
//
// Order- and chunk-independence hold BY CONSTRUCTION: the predicate never sees a row
// order, a chunk boundary, or a payload. lib/__db_tests__/hc-overlap-push-property.test.ts
// is that as a test — the same push, several orderings and chunk sizes including a 1-row
// chunk, against a NON-EMPTY store, must leave byte-identical rows every time.
//
// AND ONE MORE INVARIANT, ABOUT THE COMMITS RATHER THAN THE ORDER (#3424, the ruling of
// 2026-08-22T05:46Z). The line above is about the FINAL state; a chunked push also has
// states in between, and an earlier round put the deletes in the FIRST chunk's
// transaction: chunk 2 failing left the day reading NOTHING where `main` still read the
// old rows. So:
//
//     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
//     NEVER NEITHER. A day may read HIGH between commits; it must never read LOWER
//     than `main` would.
//
// The derivation and the deletes therefore run in the LAST chunk's transaction, after its
// upserts. One chunk: the same transaction as the rows. Many chunks: chunks 1…n−1 commit
// upserts only and the store transiently reads high (old + new, the visible double
// count), and the final chunk commits its upserts and the whole victim set together. A
// failure in chunk k leaves old + chunks<k: a double count, never a hole. Rows landed by
// chunks 1…n−1 carry the stamp and are committed, so the final transaction sees the whole
// push; a concurrent LATER push has a LATER stamp and justifies only its own deletes.
//
// The ascending-`started_at` sort survives as deterministic write order and NOTHING MORE.
// It does no work here and must not be described as what makes the store correct.

// ── PASS C'S FOUR VETOES (#3438) ──────────────────────────────────────────────────
//
// Pass C holds four UNILATERAL vetoes over what gets written:
//
//   body-metric  a measure that belongs in body_metrics, mis-routed here by a parser
//   tombstone    #508's re-import tombstone — the user deleted this exact reading
//   edit-lock    #133's lock — the stored twin is hand-corrected and wins
//   stale-retry  #1101's moving-END rule — the stored twin holds the newer snapshot
//
// They are stated ONCE, here, so the upsert loop tests four conditions in one place and
// the accounting each branch owns lives in `VETO_TALLY`. A fifth veto means adding a
// member to `MetricSampleVeto` — a compile error at `VETO_TALLY`, a `Record` over the
// union, until its accounting is stated — and adding its condition to `metricSampleVeto`,
// which is the ONLY place pass C may decline a row: the upsert loop has no other
// `continue`.
//
// THE SUPERSEDE NO LONGER CONSULTS THEM, and that is not an omission. It asks the store
// what carries this push's stamp, which is exactly the set of rows no veto stopped — see
// the header above. Round 7 refuted the version that consulted them at plan time, and
// rounds 8 and 9 refuted the re-statement clauses that consulting them made necessary.
export type MetricSampleVeto =
  "body-metric" | "tombstone" | "edit-lock" | "stale-retry";

/** The stored row under an incoming row's ON CONFLICT natural key — pass C's `found`. */
interface MetricSampleTwin {
  id: number;
  value: number;
  date: string;
  ended_at: string;
  edited: number;
  activity_external_id: string | null;
}

/**
 * What each veto does to the counts a person reads in Review.
 *
 * A `Record` over the union rather than a switch, so a fifth veto does not COMPILE until
 * it has said what Review shows for it.
 */
const VETO_TALLY: Record<MetricSampleVeto, (counts: UpsertCounts) => void> = {
  // NOT COUNTED, deliberately. A parser mis-routing a body metric into the samples path
  // is a programming error rather than a disposition; counting it would re-split the
  // measure across two tables in Review as well as in the store.
  "body-metric": () => {},
  tombstone: (counts) => {
    counts.suppressed++;
  },
  // Its OWN split (#659), like the body-metrics and vitals paths: a lock hold is not an
  // ordinary no-op re-send, so it stays visible in Review rather than hidden inside
  // `unchanged`.
  "edit-lock": (counts) => {
    counts.edited++;
  },
  "stale-retry": (counts) => {
    tallyUpsert(counts, classifyUpsert(true, true));
  },
};

interface MetricSampleVetoes {
  /** The stored row under this incoming row's natural key, or undefined. */
  twin(r: NormMetricSample): MetricSampleTwin | undefined;
  /** Why pass C will refuse to write this row, or null when it will write it. */
  veto(
    r: NormMetricSample,
    twin: MetricSampleTwin | undefined
  ): MetricSampleVeto | null;
}

/**
 * The veto set for one (profile, source), prepared once per push.
 *
 * The tombstone set and the twin statement are read ONCE for the batch, so the upsert
 * loop pays for them per push rather than per row.
 */
function metricSampleVetoes(
  profileId: number,
  source: string
): MetricSampleVetoes {
  // The pre-image read on the ON CONFLICT natural key. `id` is carried so an update's
  // provenance row (#1333) names the existing row rather than relying on lastInsertRowid
  // (unreliable for an ON CONFLICT DO UPDATE).
  const find = db.prepare(
    "SELECT id, value, date, ended_at, edited, activity_external_id FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ? AND started_at = ?"
  );
  // Re-import tombstones for metric_samples (#508): a user-deleted sample must not be
  // re-inserted by the rolling window. Loaded once for the batch.
  const tombstoned = loadImportTombstones(profileId, "metric_samples");
  return {
    twin: (r) =>
      find.get(profileId, r.metric, source, r.origin ?? null, r.started_at) as
        MetricSampleTwin | undefined,
    veto: (r, twin) => {
      // These belong in body_metrics (via upsertBodyMetrics); never let them land in
      // metric_samples and re-split the measure across two tables.
      if (BODY_METRIC_SAMPLE_MEASURES.includes(r.metric)) return "body-metric";
      // No live row AND a tombstone for this natural key: the resurrecting insert is
      // refused, so this row lands nowhere at all.
      if (
        !twin &&
        tombstoned.has(
          metricSampleTombstoneKey(
            r.metric,
            source,
            r.origin ?? null,
            r.started_at
          )
        )
      )
        return "tombstone";
      // The #133 user-edit lock, which metric_samples gained in #1488 alongside the
      // detail-page readings table's per-row Edit. A hand-corrected sample survives every
      // later re-push of the rolling window — the same contract activities /
      // body_metrics / medical_records have had since #133.
      if (twin && isEditLocked(twin.edited)) return "edit-lock";
      // A delayed retry of an older cumulative snapshot must never roll a newer
      // day-so-far value backward — #1101's moving-END rule, for the natural-key twin and
      // NOTHING ELSE. The natural key intentionally omits `ended_at`, so freshness is an
      // explicit part of the runtime merge rule (#1101 review).
      //
      // IT IS NOT A GATE ON THE SUPERSEDE, and #3424 took it out of that job for good:
      // `isStaleMetricSnapshot` compares `ended_at`, the comparison
      // lib/metric-window-overlap.ts's header spends a page explaining cannot decide
      // which of two ANCHORINGS is current, and as a gate it was STRICT so a
      // byte-identical replay walked straight through it. What it decides here is
      // whether THIS ROW lands — and that decision is all the supersede needs, because a
      // row that does not land is never stamped and so justifies no delete.
      if (twin && isStaleMetricSnapshot(twin.ended_at, r.ended_at))
        return "stale-retry";
      return null;
    },
  };
}

/** One row this push wrote, read back from the store inside the deleting transaction. */
interface StampedDayBucket extends MetricWindow {
  metric: string;
  origin: string | null;
}

/** What the supersede did, for the counts a person reads in Review. */
export interface SupersedeOutcome {
  /** Stored rows this push collapsed — `counts.superseded`. */
  removed: number;
  /**
   * Day buckets still reading HIGH once this push finished, as DISTINCT readings:
   * stored rows the predicate declined, plus the excess this push carries against
   * ITSELF. The reason does not matter to the person reading their totals.
   */
  overlapsLeft: number;
}

/**
 * THE VICTIM SET, DERIVED FROM THE STORE, UNDER THE LOCK, AND DELETED IN THE SAME
 * TRANSACTION (#3424, the owner's ruling of 2026-08-22T13:46Z).
 *
 * CALLED ONCE PER PUSH, INSIDE THE LAST CHUNK'S `writeTx` AND AFTER THAT CHUNK'S UPSERTS.
 * `writeTx` is `.immediate()`, so between the first read here and the last DELETE no
 * other process can commit anything: every fact the predicate rests on is read in the
 * transaction that acts on it. That is the whole of what closes rounds 7, 8 and 9 — see
 * the header above, which also records what the payload-side plan used to do instead.
 *
 * THE PREDICATE, AND WHERE EACH CLAUSE LIVES.
 *
 *   1. `WHERE pushed_at = ?` on the FIRST query — THE ROWS THIS PUSH WROTE. Every upsert
 *      that runs stamps the row, `unchanged` re-sends included; a row a veto stopped is
 *      not stamped and so justifies nothing. Rows landed by chunks 1…n−1 are committed
 *      and carry the stamp too, so one query sees the whole push.
 *   2. `isSupersedingWindow` on each of them — the METRIC list and the GRANULARITY gate.
 *      Nutrition and sleep nest legitimately and never tile; the same four metrics arrive
 *      as MINUTE buckets at a `1m`/`15m` exporter setting and two devices that set no
 *      `metadata.data_origin` share `origin = null`, where an overlap is two readings
 *      being summed. Neither may supersede. This is also the cost bound: an 11.5k-row
 *      `1m` push clears the gate nowhere and issues no candidate query at all.
 *   3. `AND date = ?` on the candidate query — COVER THE DAY. A stamped bucket may only
 *      collapse rows filed under ITS OWN `date`, which is the unit `getMetricDailyTotals`
 *      sums by and the unit a person reads. It is what makes "a date always keeps a
 *      reading" structural: the justifier is itself a stored row on that date and can
 *      never be a victim (clause 4 excludes it), so the day is left holding at least it.
 *      Without this term the PREVIOUS day's re-anchored bucket — which overlaps this
 *      day's stored row by the zone offset — justified deleting a row nothing replaced,
 *      and the day went to zero (#3424 round 10).
 *   4. `AND pushed_at IS NOT ?` on the candidate query — "its key is not one this push
 *      wrote", NULL-safely. Two rows of one push share a stamp, so neither can be the
 *      other's victim: a push carrying BOTH anchorings writes both and the day double
 *      counts visibly (ruling item 3), which `overlapsLeft` says out loud.
 *   5. `planSupersede` — the `date` term again (the two-encodings discipline: SQL
 *      narrows, lib/metric-window-overlap.ts decides), the overlap as INSTANTS (never as
 *      strings: `started_at` is a documented `mixed`-shape column), the stored row's own
 *      day-bucket granularity, `pushOutranks` (the stamp comparison, with NULL read as
 *      UNKNOWN and the era markers as the only thing that licenses deleting one), and
 *      the #133 edit lock.
 *
 * `overlapsLeft` IS COMPUTED FROM THE SAME QUERY, so it describes what happened rather
 * than being maintained beside it. Two terms:
 *
 *   • the candidates the predicate DECLINED — locked, not outranked, or cut at sub-daily
 *     granularity — as DISTINCT stored rows, because one stored row overlapped by two
 *     stamped buckets is one reading left double counting and counting pairs said 2.
 *     ON THE VICTIM'S OWN `date`, and ONLY there: a stamped bucket overlapping a stored
 *     row filed under a DIFFERENT date is the day-bucket chain, not a double count —
 *     the two never sum into one day — so it is neither collapsed nor reported. The
 *     `date` term therefore decides both halves of this function, which is why
 *     `planSupersede` states it rather than leaving it to the SQL.
 *     There is no prune of collapsed ids from this set: every reason a candidate is
 *     declined is a fact about that stored row plus this push's one stamp, and all the
 *     buckets that can see it share both the date and the stamp, so two of them cannot
 *     disagree. The line that used to re-subtract them was unreachable and is gone
 *     (`CLAUDE.md`: no defensive check for a condition control flow already proves).
 *   • the excess this push carries against ITSELF: a stamped day bucket overlapping an
 *     earlier-starting stamped day bucket FILED UNDER THE SAME `date`. No stored id can
 *     hold that shape, and the store-holds-neither push used to report nothing at all. It
 *     needs no dedupe on this side of the ruling — the store holds ONE row per natural
 *     key, so a record sent twice is one row and says nothing (round 8b).
 *
 * THE ONE DOUBLE COUNT NOBODY MENTIONS, left deliberately and in writing: two STORED rows
 * that overlap each other under a push that stamped nothing near them. Asking "do two
 * stored rows overlap each other" is a different scan with a different unit (excess
 * readings per cluster, not distinct rows this push touched), it would change the Review
 * line on every push rather than on this one, and `main` is silent on it too.
 *
 * THE DELETE IS BY ID AND RE-STATES `profile_id`, redundantly and on purpose: every id
 * came out of the profile-scoped candidate SELECT above. A barrier nothing observes is a
 * barrier a refactor deletes as noise — so the check that holds it is
 * lib/__tests__/profile-scoping.test.ts, the repo's own owned-table census, which reads
 * this LITERAL and fails when the clause is not there. That is also why the SQL is not
 * hoisted to a named constant: the census can only read a statement written inline.
 *
 * WHAT THAT CENSUS COVERS, EXACTLY, because "held by a test" reads wider than it is.
 * Measured, four runs:
 *
 *   • REMOVE the clause: the census reds — its "no owned-table statement missing
 *     profile_id" case — and the whole db tier stays green, 6624 passed.
 *   • REWRITE it as a literal-preserving tautology, `(profile_id = ? OR 1 = 1)`: NOTHING
 *     anywhere reds — census 15/15 green, db tier 6624/6624 green.
 *
 * So the census is a TEXT ratchet against the clause going MISSING, not a behavioural
 * observation of it doing work — and it cannot be one on its own, because with the
 * candidate SELECT correct every id handed here already belongs to the profile.
 *
 * IT IS STILL THE SECOND BARRIER, AND THAT MUCH IS OBSERVED. Neutralise the candidate
 * SELECT's own `profile_id` the same way and 14 tests red — but R5 ("keeps another
 * profile's overlapping row of the same metric and origin",
 * lib/__db_tests__/hc-overlap-supersede-refutations.test.ts) is NOT one of them: the
 * leaked id reaches this DELETE and this DELETE refuses it. Neutralise BOTH and R5 reds.
 * The first query's `profile_id` reds 20 under the same tautology. Two barriers, each
 * standing in for the other's failure.
 *
 * IT CARRIES NO `pushed_at IS ?` OR `EXISTS` RE-STATEMENT, and their absence is the
 * ruling rather than an oversight. Those clauses existed because the plan was read in one
 * transaction and applied in another; here there is no interval to defend, and a clause
 * that can never fire is a clause the next reader defends.
 *
 * The deletes are sync-internal — they write no re-import tombstone, because the source
 * is expected to keep sending the span under its current anchoring. (The #608 timezone
 * sweep's deletes were the precedent for that; #3551 replaced the sweep itself with
 * lib/integrations/ingest-timezone-reconcile.ts, which re-keys a measure rather than
 * deleting a row, so the precedent is now history rather than a neighbour.)
 */
export function supersedeMetricSampleOverlaps(
  profileId: number,
  source: string,
  pushedAt: string | null
): SupersedeOutcome {
  // Health Connect is the ONE source whose day buckets re-anchor under the app's feet,
  // and a push that states no readable instant stamps nothing — so it wrote no row that
  // could justify a delete, and there is nothing in the store for this to read.
  if (source !== OVERLAP_SUPERSEDE_SOURCE || pushedAt === null)
    return { removed: 0, overlapsLeft: 0 };

  // THE ROWS THIS PUSH WROTE, asked of the store rather than remembered from the payload.
  // Indexed by `idx_metric_samples_pushed` (20260822-hc-pushed-at-index) — without it
  // this is a scan of the profile's whole `metric_samples` history on every push.
  const stamped = db
    .prepare(
      `SELECT id, metric, origin, date, started_at, ended_at, edited, pushed_at
         FROM metric_samples
        WHERE profile_id = ? AND source = ? AND pushed_at = ?
        ORDER BY id`
    )
    .all(profileId, source, pushedAt) as StampedDayBucket[];
  // Only the ones the rule may act on at all: a tiling metric, cut at day-bucket
  // granularity.
  //
  // THIS FILTER IS A COST BOUND, AND `planSupersede` IS THE SAFETY ONE. Dropping it
  // deletes nothing extra — `planSupersede` asks `isSupersedingWindow` of the incoming
  // window itself and routes anything below the gate to `left` rather than `supersede`.
  // What it buys is the candidate query: an 11.5k-row `1m` push clears the gate NOWHERE,
  // so it issues one indexed lookup and stops, instead of ~11.5k range queries. The one
  // thing it costs is a report — a fine-grained incoming row landing on a stored day
  // bucket is a day reading high and is deliberately not named, for exactly that cost.
  // Pinned by "says nothing when a `1m` push lands on a stored day bucket".
  const buckets = stamped.filter((row) =>
    isSupersedingWindow(row.metric, row.started_at, row.ended_at)
  );
  if (buckets.length === 0) return { removed: 0, overlapsLeft: 0 };

  // WHEN `pushed_at` STARTED BEING WRITTEN, AND WHAT WAS ALREADY IN THE TABLE. The only
  // thing that licenses deleting a NULL-stamped row, read once because it never moves.
  const era: UnstampedEra | null = readUnstampedEra();
  // The stored rows a stamped bucket may supersede: same profile / metric / source /
  // origin, ON THE BUCKET'S OWN `date`, and NOT a row this push wrote. The overlap test
  // itself is deliberately NOT in this SQL — `started_at` is a documented `mixed`-shape
  // column, so string comparison would answer a different question than instants do. SQL
  // narrows; lib/metric-window-overlap.ts decides, and it states the `date` term too —
  // the narrowing must never be the only place a DELETE condition lives.
  //
  // MEASURED, because the previous version of this comment named an index the planner
  // did not pick. Over a 64,800-row `metric_samples` with `ANALYZE` run, this resolves to
  //     SEARCH metric_samples USING INDEX idx_metric_samples_md
  //       (profile_id=? AND metric=? AND date=?)
  // with NO temp b-tree: all three leading columns are pinned to equality, so the index
  // hands back the group already in rowid order and `ORDER BY id` is free. The day-radius
  // form this replaced pinned only two and paid `USE TEMP B-TREE FOR ORDER BY`.
  const findOverlaps = db.prepare(
    `SELECT id, date, started_at, ended_at, edited, pushed_at
       FROM metric_samples
      WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ?
        AND date = ?
        AND pushed_at IS NOT ?
      ORDER BY id`
  );

  const victims = new Set<number>();
  const left = new Set<number>();
  for (const bucket of buckets) {
    const candidates = findOverlaps.all(
      profileId,
      bucket.metric,
      source,
      bucket.origin,
      bucket.date,
      pushedAt
    ) as MetricWindow[];
    const plan = planSupersede({ ...bucket, pushedAt }, candidates, era);
    for (const row of plan.left) left.add(row.id);
    for (const row of plan.supersede) victims.add(row.id);
  }
  // THE EXCESS THIS PUSH CARRIES AGAINST ITSELF. "Overlaps a row of this push that starts
  // earlier, under the same `date`" is the whole definition: in a pair exactly one row has
  // the later start, so a push carrying both anchorings of one day counts 1 — the same
  // number the store-holds-one configuration reports for the same symptom, where the stale
  // row is a stored one. It is not saying which row is wrong; two rows of one push share a
  // stamp, so nothing ranks them, and choosing is what cost a reading twice.
  //
  // THE `date` IS PART OF THE GROUP, AND WITHOUT IT THIS OVER-REPORTS. `getMetricDailyTotals`
  // sums by `date`, so two rows make a day read high exactly when they are filed under the
  // same one. A re-anchored push CHAINS across days — the LA 08-19 bucket
  // [08-19 07:00Z, 08-20 07:00Z) overlaps the NY 08-20 bucket [08-20 04:00Z, 08-21 04:00Z)
  // by three hours — and counting that pair says two days read high over a store where
  // exactly one does. The payload-side plan suppressed it by a different route (the pair
  // touched a natural key already named in `leftStanding`); on this side of the ruling the
  // stored rows carry the stamp and are never candidates, so the `date` is what carries it.
  // Measured on the property suite's mixed-anchoring scenario: 2 without, 1 with, one day
  // actually double counting.
  const groups = new Map<string, StampedDayBucket[]>();
  for (const row of buckets) {
    const key = JSON.stringify([row.metric, row.origin, row.date]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  let inPushDoubleCounts = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      compareWindowStarts(a.started_at, b.started_at)
    );
    for (let i = 1; i < sorted.length; i++) {
      for (let j = 0; j < i; j++) {
        if (
          windowsOverlap(
            sorted[j].started_at,
            sorted[j].ended_at,
            sorted[i].started_at,
            sorted[i].ended_at
          )
        ) {
          inPushDoubleCounts++;
          break;
        }
      }
    }
  }

  const dropOverlap = db.prepare(
    "DELETE FROM metric_samples WHERE id = ? AND profile_id = ?"
  );
  let removed = 0;
  for (const id of victims) removed += dropOverlap.run(id, profileId).changes;
  return { removed, overlapsLeft: left.size + inPushDoubleCounts };
}

/**
 * THE DAY A RE-SENT ROW IS FILED UNDER (#3428, the write-side half).
 *
 * `metric_samples.date` is a PROFILE-LOCAL day the app derived at ingest from the row's
 * own instants, under `getTimezone(profileId)` — the zone in force AT THE MOMENT OF THE
 * PUSH. The natural key omits `date` (migration 083), so a re-send of the same row lands
 * as an ON CONFLICT UPDATE, and before this function every re-send RE-DERIVED that day
 * under whatever zone the profile holds NOW.
 *
 * That is a live corruption after a travel switch, measured on prod (#3428, owner
 * 2026-08-23T05:42:56Z): the 08-21 night (`sleep_min` 01:15Z → 08:59Z) was hand-repaired
 * from wake-day 08-20 back to 08-21 at 03:13Z, and the next push six minutes later put
 * all 72 rows of that session back on 08-20 under Honolulu. The exporter re-sends a sleep
 * session on EVERY push while it is inside its 48 h window, not only on change, so the
 * re-dating recurs for two days after a switch and no hand repair sticks.
 *
 * THE RULE: a stored `date` is not recomputed by a re-send. It is #3428's decision 4
 * ("stored `date` columns keep winning — a day attribution is a decision the app already
 * made", the rule `rowLocalDay` already applies on READ) moved to the write, so the store
 * and the reader finally agree. The row's day stays the one it was attributed under the
 * zone in force when it was attributed, which is what `zoneAt(profileId, instant)` would
 * compute for every row whose instants did not move — i.e. every row of a re-send.
 *
 * IT IS NOT `zoneAt`, AND THAT IS DELIBERATE. The resolver of #3428 item 3 needs the
 * COMPLETE, unbounded switch history of item 2, which does not exist: today's
 * `profile_settings.timezone_switches` is written only by `switchProfileTimezone`
 * (`lib/settings/travel.ts`) — a Settings or onboarding `setTimezone` leaves no record at
 * all — and it is pruned (`MAX_STORED_SWITCHES` / `SWITCH_RETENTION_DAYS`). A resolver
 * over that history would silently do nothing on the Settings path. Item 2 is also
 * blocked on the owner's `kind: travel | settings` discriminator (#3428 comments of
 * 2026-08-23T00:58Z and 01:01:51Z), because #3263's `isExcusedSlot` / `isRepeatedSlot`
 * read travel switches ONLY. So this lane takes the owner's stated alternative — "or
 * simply a stored `date` is not recomputed by a re-send" — and the resolver replaces it
 * when the history it needs is real.
 *
 * THE BROAD EXCEPTION IS GONE, AND ITS REMOVAL IS #3901's THIRD HALF.
 *
 * This function used to carve out the re-anchorable day buckets — `isSupersedingWindow`
 * rows, whose `date` was not an attribution of an instant at all but the profile's zone
 * read over a window the DEVICE had cut. Freezing them stranded a stale bucket on a day
 * no later bucket shared (`travel-hc-double-count` red at `expected 3500 to be 6500`,
 * the store split `[{"2026-05-01":3500},{"2026-05-02":3000}]`); re-deriving them let the
 * row that had just justified a supersede change its mind about which day it was on and
 * walk off the day it emptied — two prod days of steps, distance and kcal (#3901).
 *
 * BOTH HORNS CAME FROM DERIVING THE DAY FROM THE ZONE. `anchorImpliedDay` derives it
 * from `started_at`, which IS the natural key, so a re-send computes the same day it
 * computed last time: freeze and re-derive agree, there is nothing left to choose, and
 * the freeze below is what makes that structural. A justifying row's `date` can no
 * longer move after the delete it justified, so "a date always keeps a reading" holds
 * ACROSS pushes and not only within one.
 *
 * THEY AGREE ONLY ONCE THE BUCKET IS WIDE ENOUGH TO STATE ITS ANCHOR, which is the
 * narrow exception that remains, and it is a repair rather than a re-derive: see the
 * body. A bucket's first push can be narrower than `SUB_DAILY_WINDOW_MAX_MIN`, and the
 * profile-zone day it is provisionally given must not be frozen in forever.
 *
 * THAT ONE EXCEPTION *IS* SOURCE-GATED, unlike the freeze around it, and the asymmetry is
 * the point. The freeze declines to overwrite a day the store already chose, which is
 * conservative for every source. The repair OVERWRITES, and it is only sound where
 * `incoming.date` is itself read off the anchor — which is a property of the Health
 * Connect parser, not of this function. Ungated it re-dates other sources on a travel
 * switch: Strava and Oura file `active_kcal` on a workout's REAL window, so a ride over
 * an hour clears `isSupersedingWindow`, and a 02:00Z start stored under Honolulu as 08-24
 * has an anchor-implied day of 08-25 — so the "repair" would hand it whatever the CURRENT
 * profile zone computes. That is #3428's defect exactly, which is what this file exists
 * to prevent.
 *
 * THE FREEZE IS NOT GATED ON THE SOURCE, unlike `OVERLAP_SUPERSEDE_SOURCE`. That gate exists because
 * the supersede DELETES readings, so it must never reach a source whose windows it has
 * not been argued about. This one only DECLINES TO OVERWRITE a day the store already
 * chose, which is the conservative direction for every source: Health Connect, the Fitbit
 * takeout and Strava all derive `date` from the PROFILE's zone and re-send (a rolling 48 h
 * window, a re-import, a trailing re-scan), and for the sources that carry their own day
 * (Oura's `day`, the manual writers, the glucose trace) `date` is a function of the
 * natural key, so there is nothing for this to change.
 */
function resendDay(
  incoming: NormMetricSample,
  twin: MetricSampleTwin | undefined,
  source: string
): string {
  if (!twin) return incoming.date;
  // THE ONE DAY THE FREEZE MAY NOT KEEP: one the row's OWN ANCHOR REFUSES.
  //
  // A bucket narrower than `SUB_DAILY_WINDOW_MAX_MIN` states no anchor yet, so its first
  // push is filed under the profile's zone — the NEIGHBOUR's day, inside a skew window.
  // Freezing that provisional answer makes it permanent: the bucket grows past the hour,
  // the parser derives the right day, and the freeze discards it on every push forever.
  // MEASURED: a NY bucket (`04:00Z`) first pushed 30 minutes after the device's midnight
  // while the profile still held Los Angeles sat on 08-26 beside the real 6608, and
  // 2026-08-27 never received a row at all — the hole this issue is about, re-opened by
  // the carve-out's removal rather than by the carve-out.
  //
  // IT IS A REPAIR, NOT A RE-DERIVE, and three things keep it from being the mutable
  // date that emptied a prod day. It moves a row only OFF a day its own anchor says it
  // was never lived in, and — because the source gate holds `incoming.date` to
  // `anchorImpliedDay`'s answer — only ONTO the day that anchor names. `anchorRefusesDay`
  // takes no zone, so in the ambiguous 10:00Z-12:00Z band BOTH days are admissible and a
  // row there is never moved when the profile travels. And a row that has JUSTIFIED a
  // supersede is anchor-admissible by construction — `planSupersede` refuses a victim to
  // any bucket whose anchor contradicts its `date` — so the justifier can still never
  // walk off the day it emptied.
  //
  // IT ALSO RELABELS HISTORY, once, and that is worth knowing rather than discovering.
  // Every stored bucket whose pre-#3901 `date` is anchor-inadmissible moves the first
  // time the exporter's ~48 h window re-sends it, so for two days the store holds both
  // conventions and older buckets keep theirs for good. That is a correction where it
  // fires; #3927 owns the historical set.
  if (
    source === OVERLAP_SUPERSEDE_SOURCE &&
    isSupersedingWindow(
      incoming.metric,
      incoming.started_at,
      incoming.ended_at
    ) &&
    anchorRefusesDay(incoming.started_at, twin.date)
  ) {
    return incoming.date;
  }
  return twin.date;
}

export function upsertMetricSamples(
  profileId: number,
  rows: NormMetricSample[],
  source: string,
  sink?: SyncRowSink,
  options: MetricSampleUpsertOptions = {}
): UpsertCounts {
  // The pre-image on the natural key the ON CONFLICT below merges on, and the four
  // vetoes read against it (#3438). A re-send of the rolling window that lands the same
  // value/date is counted unchanged rather than a write (info.changes can't see that the
  // values matched) — and is still STAMPED, which is what lets an `unchanged` re-send
  // justify a supersede exactly as an insert does.
  const vetoes = metricSampleVetoes(profileId, source);
  const stmt = db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, started_at, ended_at, value,
        activity_external_id, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       value = excluded.value,
       -- excluded.date IS NOT THE PAYLOAD'S DATE ON A RE-SEND (#3428). The bound
       -- parameter is resendDay()'s answer, which whenever the store already holds this
       -- natural key is the STORED day. See its header: a re-send must not re-attribute
       -- a row to a day it was not lived in.
       date = excluded.date,
       ended_at = excluded.ended_at,
       activity_external_id = COALESCE(
         excluded.activity_external_id,
         metric_samples.activity_external_id
       ),
       -- The stamp of the push that last WROTE this row. COALESCE so a caller with no
       -- stamp (every non-Health-Connect source) cannot blank one that a stamped push
       -- already set, which would re-open the row to a replay.
       pushed_at = COALESCE(excluded.pushed_at, metric_samples.pushed_at)`
  );
  const counts = emptyCounts();

  // ── PASS C, AND ONLY PASS C (#3424) ───────────────────────────────────────────
  //
  // THERE IS NO SUPERSEDE IN THIS LOOP, and that is the change nine adversarial rounds
  // bought. It used to find the overlaps and DELETE them per row, right here, next to the
  // `found` pre-image read that #1101's moving-END merge needs — so one row of a push
  // could invalidate what a LATER row of the same push observed. Reached through arrival
  // order (round 1) and through the natural-key twin lookup (round 5); one defect, two
  // doors. The comment that used to stand here argued that an equal stamp made a chunk
  // split harmless. That was right about the stamp channel and wrong to claim the
  // universal: rows of one push cannot be each other's VICTIMS, which says nothing about
  // what the twin lookup returns.
  //
  // The deletes now run ONCE, in `supersedeMetricSampleOverlaps`, inside the LAST chunk's
  // transaction and AFTER this loop has run in it — so nothing this loop reads can have
  // been moved by a delete, in any chunk, with no exclusion set to get right. Every
  // `found`, `staleRetry`, lock decision and disposition below is what it would be with
  // no supersede at all.
  //
  // What is left of the rule in this function is one column: `pushed_at`, the stamp the
  // exporter stated on this push, written onto every row it stores so a LATER push can
  // rank itself against them. A caller with no stamp writes NULL and COALESCE keeps
  // whatever a stamped push already set, so a non-Health-Connect source cannot blank one.
  const pushedAt =
    source === OVERLAP_SUPERSEDE_SOURCE ? (options.pushedAt ?? null) : null;
  // ASCENDING started_at — DETERMINISTIC WRITE ORDER, and nothing more.
  //
  // #3424 asks for it under the trailing-edge heading, and it used to be load-bearing:
  // when a row of a push could supersede another row of the SAME push, which one arrived
  // first decided what survived. It cannot any more, and NOT because of the stamp — the
  // deletes do not happen here at all. It is kept because a stable write order makes
  // `metric_samples.id` follow the day, which is worth having for anyone reading the
  // table by hand, and because it costs one sort of a batch already in memory. It is NOT
  // what makes the store correct, and the test that pins it asserts insertion ORDER for
  // that reason.
  const ordered =
    source === OVERLAP_SUPERSEDE_SOURCE
      ? [...rows].sort((a, b) =>
          compareWindowStarts(a.started_at, b.started_at)
        )
      : rows;

  for (const r of ordered) {
    const found = vetoes.twin(r);
    // THE FOUR VETOES, AND THE ONLY PLACE THIS LOOP MAY DECLINE A ROW (#3438). They used
    // to stand here as four inline conditions; they are stated once in
    // `metricSampleVetoes` so the accounting lives in `VETO_TALLY`, a `Record` over the
    // union, and a fifth veto does not compile until it says what Review shows.
    //
    // A VETOED ROW IS NOT STAMPED, and that one fact is the whole of how the supersede
    // honours these. It never asks why a row was refused — it asks the store what carries
    // this push's stamp, and a row that landed nowhere is not in that set. A fifth veto
    // costs the supersede no edit at all.
    //
    // The reads behind them see a store no delete has touched: the supersede runs after
    // this loop, in the last chunk's transaction.
    const veto = vetoes.veto(r, found);
    if (veto !== null) {
      VETO_TALLY[veto](counts);
      continue;
    }
    // #3428: the day this row is FILED under, which on a re-send is the day the store
    // already chose. `resendDay`'s header carries the whole argument.
    const date = resendDay(r, found, source);
    const info = stmt.run(
      profileId,
      source,
      r.origin ?? null,
      r.metric,
      date,
      r.started_at,
      r.ended_at,
      r.value,
      r.activity_external_id ?? null,
      pushedAt
    );
    // COMPARED AGAINST THE DAY ACTUALLY WRITTEN, not against `r.date`. A re-send carrying
    // a zone-shifted day now stores nothing new, so Review must call it `unchanged`
    // rather than reporting an update that did not happen (#3428).
    const equal =
      !!found &&
      found.value === r.value &&
      found.date === date &&
      found.ended_at === r.ended_at &&
      (r.activity_external_id == null ||
        found.activity_external_id === r.activity_external_id);
    const disposition = classifyUpsert(!!found, equal);
    tallyUpsert(counts, disposition);
    // Per-row provenance (#1333) — only the value-changing dispositions. An update
    // names the pre-image row's id; an insert uses the fresh rowid.
    if (disposition !== "unchanged") {
      sink?.push({
        target_table: "metric_samples",
        target_id: found ? found.id : Number(info.lastInsertRowid),
        disposition,
      });
    }
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
    const equal =
      !!found &&
      found.bpm === r.bpm &&
      found.bpm_min === r.bpm_min &&
      found.bpm_max === r.bpm_max &&
      found.n === r.n;
    tallyUpsert(counts, classifyUpsert(!!found, equal));
  }
  return counts;
}

// Insert or update a vital/biomarker reading into medical_records, deduped on
// external_id. Only ever touches rows this source created (external_id is NULL for
// manual + document-extracted rows). Returns the affected row ids so the caller can
// run reconcileFlags() to set out-of-range flags. `value` mirrors value_num as text
// (the medical UI shows `value`).
//
// A re-issued result (#1404) does NOT silently replace what the user already read:
// when the incoming row supersedes the stored one — a changed value/unit/date, or an
// incoming status the source itself calls corrected/amended — the prior state is
// preserved as a medical_record_revisions child row FIRST, inside this same
// transaction, and only then is the reading updated in place. The reading keeps its
// id (every link, star, dismissal and provenance row points at it), and the value it
// used to hold is still there to show. An idempotent re-send of the rolling window
// is `unchanged` and writes nothing at all.
const VITAL_COMPARE_COLS: string[] = [
  "date",
  // The stated instant (#2154). In the compare set so a re-send of the rolling
  // window BACKFILLS a pre-#2154 row's occurred_at (stored NULL, incoming
  // instant → "updated", not "unchanged") — the one write path historical
  // device rows have; occurred_at alone never supersedes (no revision row).
  "occurred_at",
  "category",
  "name",
  "value",
  "value_num",
  "unit",
  "canonical_name",
  "result_status",
];

function resendLocalField<T>(source: string, stored: T, incoming: T): T {
  return source === HEALTH_CONNECT_ID ? stored : incoming;
}

export function upsertVitals(
  profileId: number,
  rows: NormVital[],
  source: string,
  sink?: SyncRowSink
): { ids: number[]; counts: UpsertCounts } {
  const find = db.prepare(
    `SELECT id, edited, date, occurred_at, category, name, value, value_num, unit,
            canonical_name, reference_range, flag, result_status
       FROM medical_records WHERE profile_id = ? AND external_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, occurred_at, category, name, value, value_num, unit, canonical_name, source, external_id, result_status, logged_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE medical_records
       SET date = ?, occurred_at = ?, category = ?, name = ?, value = ?, value_num = ?,
           unit = ?, canonical_name = ?, result_status = ?
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
      const status = normalizeResultStatus(r.result_status);
      const post = {
        date: resendLocalField(source, found.date as string, r.date),
        occurred_at: r.occurred_at ?? null,
        category: r.category,
        name: r.name,
        value: valueStr,
        value_num: r.value_num,
        unit: r.unit,
        canonical_name: r.canonical,
        result_status: status,
      };
      const disposition = classifyUpsert(
        true,
        rowsEqual(VITAL_COMPARE_COLS, found, post)
      );
      if (disposition === "updated") {
        // A re-ISSUED result — a changed value/unit/date, or an incoming status the
        // source itself calls corrected/amended — preserves what it replaces BEFORE
        // the overwrite (#1404), in this same transaction. A re-canonicalization or
        // a category re-classification changes how the reading is FILED, not what it
        // SAID, so it updates in place with no revision row (supersedesReading owns
        // that distinction — one computation).
        if (
          supersedesReading(
            {
              date: found.date as string | null,
              value: found.value as string | null,
              value_num: found.value_num as number | null,
              unit: found.unit as string | null,
              result_status: found.result_status as string | null,
            },
            { ...post, result_status: status }
          )
        ) {
          insertObservationRevision(
            found.id,
            {
              date: found.date as string | null,
              value: found.value as string | null,
              value_num: found.value_num as number | null,
              unit: found.unit as string | null,
              reference_range: found.reference_range as string | null,
              flag: found.flag as MedicalFlag | null,
              result_status: found.result_status as string | null,
            },
            status,
            source
          );
        }
        update.run(
          post.date,
          r.occurred_at ?? null,
          r.category,
          r.name,
          valueStr,
          r.value_num,
          r.unit,
          r.canonical,
          status,
          found.id
        );
      }
      tallyUpsert(counts, disposition);
      ids.push(found.id);
      // Per-row provenance (#1333) — record only a value-changing update, not a
      // no-op re-send (unchanged).
      if (disposition === "updated") {
        sink?.push({
          target_table: "medical_records",
          target_id: found.id,
          disposition,
        });
      }
    } else {
      const info = insert.run(
        profileId,
        r.date,
        // Bound, never defaulted (#2205): the source's stated instant or honest
        // NULL for a day-grain reading.
        r.occurred_at ?? null,
        r.category,
        r.name,
        valueStr,
        r.value_num,
        r.unit,
        r.canonical,
        source,
        r.external_id,
        normalizeResultStatus(r.result_status),
        IMPORTED
      );
      const newId = Number(info.lastInsertRowid);
      ids.push(newId);
      tallyUpsert(counts, classifyUpsert(false, false));
      sink?.push({
        target_table: "medical_records",
        target_id: newId,
        disposition: "inserted",
      });
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
  source: string,
  sink?: SyncRowSink
): UpsertCounts {
  const metricCols = ACTIVITY_METRIC_COLS.join(", ");
  const metricSet = ACTIVITY_METRIC_COLS.map((c) => `${c} = ?`).join(", ");
  const metricPlaceholders = ACTIVITY_METRIC_COLS.map(() => "?").join(", ");
  // `components` is a JSON string column, compared alongside the base/metric cols so
  // a components change → updated and an identical re-sync (same serialized JSON) →
  // unchanged. Sources that omit components store/compare null on both sides.
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
  // `created_at` is BOUND from the clock seam (#2287), not left to the column's
  // `datetime('now')` DEFAULT. For an IMPORTED row this stamp is the FIRST-SEEN
  // freshness anchor `computeWorkoutPresence` compares against a seam-derived now
  // (IMPORT_FRESHNESS_MIN), so the two have to come off one clock. Byte-identical to
  // SQLite's own value in production, where the seam is the real clock.
  const insert = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, start_time, end_time, ${metricCols}, components, source, external_id, created_at, logged_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${metricPlaceholders}, ?, ?, ?, ?, ?)`
  );
  // NOTE (#342): equipment_id is deliberately absent from BOTH this UPDATE's column
  // set and the compareCols above, so a re-sync never clobbers a hand-set session
  // gear link — the picker is app-only, sources don't supply it. A user who links
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
    // the user should be able to see in Review, not a silent no-op. Routes through
    // the shared isEditLocked predicate like the body-metric/vital paths (#944).
    if (found && isEditLocked(found.edited)) {
      counts.edited++;
      continue;
    }
    if (found) {
      // Resolved post-image over the same columns the UPDATE writes (metric fields
      // reuse activityMetricValues so the compare and the write can't drift).
      const post: Record<string, unknown> = {
        date: resendLocalField(source, found.date as string, r.date),
        type: r.type,
        title: r.title,
        duration_min: r.duration_min,
        distance_km: r.distance_km,
        start_time: resendLocalField(
          source,
          found.start_time as string | null,
          r.start_time
        ),
        end_time: resendLocalField(
          source,
          found.end_time as string | null,
          r.end_time
        ),
        source,
        components: componentsJson,
      };
      ACTIVITY_METRIC_COLS.forEach((c, i) => {
        post[c] = metrics[i];
      });
      const disposition = classifyUpsert(
        true,
        rowsEqual(compareCols, found, post)
      );
      if (disposition === "updated") {
        update.run(
          post.date,
          r.type,
          r.title,
          r.duration_min,
          r.distance_km,
          post.start_time,
          post.end_time,
          ...metrics,
          componentsJson,
          source,
          found.id
        );
      }
      tallyUpsert(counts, disposition);
      // Per-row provenance (#1333) — record only a value-changing update.
      if (disposition === "updated") {
        sink?.push({
          target_table: "activities",
          target_id: found.id,
          disposition,
        });
      }
    } else if (tombstoned.has(r.external_id)) {
      // No live row AND a tombstone for this external_id: the user merged/deleted it —
      // skip the resurrecting insert and count it suppressed.
      counts.suppressed++;
      continue;
    } else {
      const info = insert.run(
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
        r.external_id,
        sqlNow(),
        IMPORTED
      );
      tallyUpsert(counts, classifyUpsert(false, false));
      sink?.push({
        target_table: "activities",
        target_id: Number(info.lastInsertRowid),
        disposition: "inserted",
      });
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
    const equal =
      !!found &&
      found.polyline === r.polyline &&
      found.start_lat === r.start_lat &&
      found.start_lng === r.start_lng &&
      found.end_lat === r.end_lat &&
      found.end_lng === r.end_lng;
    const disposition = classifyUpsert(!!found, equal);
    if (disposition === "unchanged") {
      tallyUpsert(counts, disposition);
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
    tallyUpsert(counts, disposition);
  }
  return counts;
}
