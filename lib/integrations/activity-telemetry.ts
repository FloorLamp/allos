// A session's second-by-second record, whatever the session was. The table has
// been `activity_telemetry` since migration 159, but everything ABOVE it was
// named for bicycles because the fetch was gated to rides — and #2870 step 4
// took that gate off, so a walk and a run store the same series through the same
// path. The names now say what the storage always was. (The migration keeps its
// own name: it is hash-pinned and recorded in every database that ran it.)
//
// What remains genuinely cycling lives next door in lib/cycling-stream-summary:
// the precomputed power curve and power zones the Cycling overview reads.

import { db } from "@/lib/db";
import {
  serializeCyclingStreamSummary,
  summarizeCyclingStreams,
} from "@/lib/cycling-stream-summary";
import {
  classifyUpsert,
  emptyCounts,
  tallyUpsert,
  type UpsertCounts,
} from "./sync-log";

export const STRAVA_STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
] as const;

export type ActivityStreamKey = (typeof STRAVA_STREAM_KEYS)[number];

export interface TelemetryStream {
  data: unknown[];
  original_size?: number;
  resolution?: string;
  series_type?: string;
}

export type ActivityStreams = Partial<
  Record<ActivityStreamKey, TelemetryStream>
>;

export interface NormActivityTelemetry {
  external_id: string;
  streams: ActivityStreams;
  ftp_w: number | null;
  heart_rate_zones: unknown[] | null;
  power_zones: unknown[] | null;
  snapshot_at: string;
}

export interface NormActivityLap {
  external_id: string;
  lap_external_id: string;
  lap_index: number;
  name: string | null;
  distance_m: number | null;
  moving_time_sec: number | null;
  elapsed_time_sec: number | null;
  start_index: number | null;
  end_index: number | null;
  elevation_gain_m: number | null;
  average_speed_mps: number | null;
  max_speed_mps: number | null;
  average_cadence: number | null;
  average_watts: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
}

export interface NormSegmentEffort {
  external_id: string;
  effort_external_id: string;
  segment_id: string | null;
  name: string;
  distance_m: number | null;
  moving_time_sec: number | null;
  elapsed_time_sec: number | null;
  start_index: number | null;
  end_index: number | null;
  average_cadence: number | null;
  average_watts: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  pr_rank: number | null;
  kom_rank: number | null;
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function resolveActivity(profileId: number, externalId: string): number | null {
  const row = db
    .prepare(
      "SELECT id FROM activities WHERE profile_id = ? AND external_id = ?"
    )
    .get(profileId, externalId) as { id: number } | undefined;
  return row?.id ?? null;
}

// Has the source ALREADY ANSWERED about this activity's streams? The row is the
// answer, whether or not it carries any: an activity the source recorded totals
// for ("200 OK, no streams" — an indoor session, a phone-logged walk) is a
// settled question, and re-asking buys the same empty payload at two requests a
// time. The automatic sync must ask each activity once; the USER-triggered
// backfill deliberately re-asks the empty ones, which is where a ride made
// public again or an upload Strava has since processed gets picked up
// (lib/integrations/backfill-outcome.ts explains why no give-up marker is
// stored there).
export function hasTelemetryAnswer(
  profileId: number,
  externalId: string,
  source: string
): boolean {
  return !!db
    .prepare(
      `SELECT 1
         FROM activity_telemetry t
         JOIN activities a
           ON a.id = t.activity_id AND a.profile_id = t.profile_id
        WHERE t.profile_id = ? AND a.external_id = ? AND t.source = ?`
    )
    .get(profileId, externalId, source);
}

// What the SOURCE said it holds for this session (#3037). A caller only writes a
// telemetry row once the source has ANSWERED — the sync guards on `answeredNow ||
// answered`, the backfill on two 200s — so the stored bytes are the answer:
// something means `streams`, nothing means `none`. Derived from what is actually
// STORED, never from the incoming payload, because a partial pull can arrive empty
// over a row that already holds a series.
export type TelemetryAnswer = "streams" | "none";

function answerFor(streamsJson: string): TelemetryAnswer {
  return streamsJson && streamsJson !== "{}" ? "streams" : "none";
}

export function upsertActivityTelemetry(
  profileId: number,
  rows: NormActivityTelemetry[],
  source: string
): UpsertCounts {
  const find = db.prepare(
    `SELECT streams_json, ftp_w, heart_rate_zones_json, power_zones_json, snapshot_at, answer
       FROM activity_telemetry
      WHERE profile_id = ? AND activity_id = ? AND source = ?`
  );
  const upsert = db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, ftp_w,
        heart_rate_zones_json, power_zones_json, snapshot_at,
        stream_summary_json, answer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, activity_id, source) DO UPDATE SET
       streams_json = excluded.streams_json,
       ftp_w = excluded.ftp_w,
       heart_rate_zones_json = excluded.heart_rate_zones_json,
       power_zones_json = excluded.power_zones_json,
       snapshot_at = excluded.snapshot_at,
       stream_summary_json = excluded.stream_summary_json,
       answer = excluded.answer`
  );
  const counts = emptyCounts();
  for (const row of rows) {
    const activityId = resolveActivity(profileId, row.external_id);
    if (activityId == null) continue;
    const incoming = {
      streams_json: JSON.stringify(row.streams),
      ftp_w: row.ftp_w,
      heart_rate_zones_json: json(row.heart_rate_zones),
      power_zones_json: json(row.power_zones),
      snapshot_at: row.snapshot_at,
    };
    const prior = find.get(profileId, activityId, source) as
      (typeof incoming & { answer: TelemetryAnswer | null }) | undefined;
    // The stream, athlete, and zones calls fail independently. Empty/null values
    // therefore mean "not available in this pull", not "erase the last good
    // artifact". FTP and zone values are also historical snapshots: once present
    // for a ride, a later change to the athlete's current settings must not rewrite
    // that ride's load context. A reconnect may still fill a previously-null
    // snapshot, and a successful non-empty stream refresh may replace stream data.
    const post = prior
      ? {
          streams_json:
            Object.keys(row.streams).length > 0
              ? incoming.streams_json
              : prior.streams_json,
          ftp_w: prior.ftp_w ?? incoming.ftp_w,
          heart_rate_zones_json:
            prior.heart_rate_zones_json ?? incoming.heart_rate_zones_json,
          power_zones_json: prior.power_zones_json ?? incoming.power_zones_json,
          snapshot_at: incoming.snapshot_at,
        }
      : incoming;
    const answer = answerFor(post.streams_json);
    // `answer` is part of what makes a row equal, and that is load-bearing rather
    // than tidy (#3037). A pre-column row holds `{}` with a NULL answer; a re-ask
    // that returns the same `{}` would otherwise be "unchanged", nothing would be
    // written, and the session would stay a candidate forever — which is the very
    // badge-cannot-reach-zero defect this column exists to end.
    const equal =
      !!prior &&
      prior.streams_json === post.streams_json &&
      prior.ftp_w === post.ftp_w &&
      prior.heart_rate_zones_json === post.heart_rate_zones_json &&
      prior.power_zones_json === post.power_zones_json &&
      prior.answer === answer;
    const disposition = classifyUpsert(!!prior, equal);
    // snapshot_at describes when values changed; don't churn it on an identical
    // trailing-window re-fetch.
    if (disposition !== "unchanged") {
      upsert.run(
        profileId,
        activityId,
        source,
        post.streams_json,
        post.ftp_w,
        post.heart_rate_zones_json,
        post.power_zones_json,
        post.snapshot_at,
        // The Cycling overview reads THIS instead of parsing every ride's streams
        // on every page load (#2292). It is a pure function of the two columns
        // written beside it, so it is derived from `post` — the values actually
        // stored — and never from `incoming`, which a partial pull may have left
        // empty. An "unchanged" disposition writes nothing, which is correct: the
        // stored summary already describes those same bytes. A LOGIC change (a new
        // curve duration) invalidates it by signature instead, and the boot
        // reconcile re-derives it.
        serializeCyclingStreamSummary(
          summarizeCyclingStreams(post.streams_json, post.power_zones_json)
        ),
        answer
      );
    }
    tallyUpsert(counts, disposition);
  }
  return counts;
}

function groupedChildren<T extends { external_id: string }>(
  rows: T[],
  parentExternalIds: string[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const externalId of parentExternalIds) grouped.set(externalId, []);
  for (const row of rows) {
    const group = grouped.get(row.external_id) ?? [];
    group.push(row);
    grouped.set(row.external_id, group);
  }
  return grouped;
}

function fieldsEqual(
  prior: Record<string, unknown>,
  post: Record<string, unknown>,
  fields: string[]
): boolean {
  return fields.every((field) => prior[field] === post[field]);
}

// One incoming row per external id, LAST WINS (#3194).
//
// The source's own payload can carry the same child id twice — a twin upload
// merged upstream, or (before ids were preserved through the parse) two int64 ids
// that rounded onto one string. `byExternalId` below is built from EXISTING rows
// only, so both copies looked new and both were inserted: the second insert hit
// `UNIQUE(profile_id, source, external_id)` and threw, aborting a whole backfill
// sweep. A group with a duplicate is a payload defect, not a reason to refuse the
// ride, so it collapses here and the ride still lands.
function dedupeByExternalId<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const byExternalId = new Map<string, T>();
  for (const row of rows) byExternalId.set(keyOf(row), row);
  return [...byExternalId.values()];
}

export function replaceActivityLaps(
  profileId: number,
  rows: NormActivityLap[],
  source: string,
  parentExternalIds: string[] = rows.map((row) => row.external_id)
): void {
  const fields = [
    "lap_index",
    "name",
    "distance_m",
    "moving_time_sec",
    "elapsed_time_sec",
    "start_index",
    "end_index",
    "elevation_gain_m",
    "average_speed_mps",
    "max_speed_mps",
    "average_cadence",
    "average_watts",
    "average_heartrate",
    "max_heartrate",
  ];
  const find = db.prepare(
    `SELECT id, external_id, ${fields.join(", ")}
       FROM activity_laps
      WHERE profile_id = ? AND activity_id = ? AND source = ?`
  );
  const insert = db.prepare(
    `INSERT INTO activity_laps
       (profile_id, activity_id, source, external_id, lap_index, name,
        distance_m, moving_time_sec, elapsed_time_sec, start_index, end_index,
        elevation_gain_m, average_speed_mps, max_speed_mps, average_cadence,
        average_watts, average_heartrate, max_heartrate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE activity_laps SET
       lap_index = ?, name = ?, distance_m = ?, moving_time_sec = ?,
       elapsed_time_sec = ?, start_index = ?, end_index = ?,
       elevation_gain_m = ?, average_speed_mps = ?, max_speed_mps = ?,
       average_cadence = ?, average_watts = ?, average_heartrate = ?,
       max_heartrate = ?
     WHERE id = ? AND profile_id = ?`
  );
  const remove = db.prepare(
    "DELETE FROM activity_laps WHERE id = ? AND profile_id = ?"
  );
  // The UNIQUE is (profile_id, source, external_id) — it spans EVERY activity, so
  // an id this ride now claims may still be filed under a different one. See
  // reparent below.
  const findAnywhere = db.prepare(
    `SELECT id FROM activity_laps
      WHERE profile_id = ? AND source = ? AND external_id = ?`
  );
  const reparent = db.prepare(
    `UPDATE activity_laps SET
       activity_id = ?, lap_index = ?, name = ?, distance_m = ?,
       moving_time_sec = ?, elapsed_time_sec = ?, start_index = ?, end_index = ?,
       elevation_gain_m = ?, average_speed_mps = ?, max_speed_mps = ?,
       average_cadence = ?, average_watts = ?, average_heartrate = ?,
       max_heartrate = ?
     WHERE id = ? AND profile_id = ?`
  );
  for (const [externalId, rawGroup] of groupedChildren(
    rows,
    parentExternalIds
  )) {
    const activityId = resolveActivity(profileId, externalId);
    if (activityId == null) continue;
    const group = dedupeByExternalId(rawGroup, (row) => row.lap_external_id);
    const existing = find.all(profileId, activityId, source) as (Record<
      string,
      unknown
    > & { id: number; external_id: string })[];
    const byExternalId = new Map(
      existing.map((prior) => [prior.external_id, prior])
    );
    const incoming = new Set(group.map((row) => row.lap_external_id));
    for (const prior of existing) {
      if (!incoming.has(prior.external_id)) remove.run(prior.id, profileId);
    }
    for (const row of group) {
      const values = [
        row.lap_index,
        row.name,
        row.distance_m,
        row.moving_time_sec,
        row.elapsed_time_sec,
        row.start_index,
        row.end_index,
        row.elevation_gain_m,
        row.average_speed_mps,
        row.max_speed_mps,
        row.average_cadence,
        row.average_watts,
        row.average_heartrate,
        row.max_heartrate,
      ];
      const post = Object.fromEntries(
        fields.map((field, index) => [field, values[index]])
      );
      const prior = byExternalId.get(row.lap_external_id);
      if (!prior) {
        // A lap id filed under ANOTHER activity is a re-parent, not a crash
        // (#3194). The source re-issued this id against this ride — an upstream
        // merge of twin uploads is the observed way that happens — and the row
        // belongs where the source now says it does. Inserting instead threw
        // `UNIQUE constraint failed`, which aborted the whole backfill sweep.
        const elsewhere = findAnywhere.get(
          profileId,
          source,
          row.lap_external_id
        ) as { id: number } | undefined;
        if (elsewhere)
          reparent.run(activityId, ...values, elsewhere.id, profileId);
        else
          insert.run(
            profileId,
            activityId,
            source,
            row.lap_external_id,
            ...values
          );
      } else if (!fieldsEqual(prior, post, fields)) {
        update.run(...values, prior.id, profileId);
      }
    }
  }
}

export function replaceSegmentEfforts(
  profileId: number,
  rows: NormSegmentEffort[],
  source: string,
  parentExternalIds: string[] = rows.map((row) => row.external_id)
): void {
  const fields = [
    "segment_id",
    "name",
    "distance_m",
    "moving_time_sec",
    "elapsed_time_sec",
    "start_index",
    "end_index",
    "average_cadence",
    "average_watts",
    "average_heartrate",
    "max_heartrate",
    "pr_rank",
    "kom_rank",
  ];
  const find = db.prepare(
    `SELECT id, external_id, ${fields.join(", ")}
       FROM activity_segment_efforts
      WHERE profile_id = ? AND activity_id = ? AND source = ?`
  );
  const insert = db.prepare(
    `INSERT INTO activity_segment_efforts
       (profile_id, activity_id, source, external_id, segment_id, name,
        distance_m, moving_time_sec, elapsed_time_sec, start_index, end_index,
        average_cadence, average_watts, average_heartrate, max_heartrate,
        pr_rank, kom_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE activity_segment_efforts SET
       segment_id = ?, name = ?, distance_m = ?, moving_time_sec = ?,
       elapsed_time_sec = ?, start_index = ?, end_index = ?,
       average_cadence = ?, average_watts = ?, average_heartrate = ?,
       max_heartrate = ?, pr_rank = ?, kom_rank = ?
     WHERE id = ? AND profile_id = ?`
  );
  const remove = db.prepare(
    "DELETE FROM activity_segment_efforts WHERE id = ? AND profile_id = ?"
  );
  // The UNIQUE is (profile_id, source, external_id) — it spans EVERY activity, so
  // an id this ride now claims may still be filed under a different one. See
  // reparent below.
  const findAnywhere = db.prepare(
    `SELECT id FROM activity_segment_efforts
      WHERE profile_id = ? AND source = ? AND external_id = ?`
  );
  const reparent = db.prepare(
    `UPDATE activity_segment_efforts SET
       activity_id = ?, segment_id = ?, name = ?, distance_m = ?,
       moving_time_sec = ?, elapsed_time_sec = ?, start_index = ?, end_index = ?,
       average_cadence = ?, average_watts = ?, average_heartrate = ?,
       max_heartrate = ?, pr_rank = ?, kom_rank = ?
     WHERE id = ? AND profile_id = ?`
  );
  for (const [externalId, rawGroup] of groupedChildren(
    rows,
    parentExternalIds
  )) {
    const activityId = resolveActivity(profileId, externalId);
    if (activityId == null) continue;
    const group = dedupeByExternalId(rawGroup, (row) => row.effort_external_id);
    const existing = find.all(profileId, activityId, source) as (Record<
      string,
      unknown
    > & { id: number; external_id: string })[];
    const byExternalId = new Map(
      existing.map((prior) => [prior.external_id, prior])
    );
    const incoming = new Set(group.map((row) => row.effort_external_id));
    for (const prior of existing) {
      if (!incoming.has(prior.external_id)) remove.run(prior.id, profileId);
    }
    for (const row of group) {
      const values = [
        row.segment_id,
        row.name,
        row.distance_m,
        row.moving_time_sec,
        row.elapsed_time_sec,
        row.start_index,
        row.end_index,
        row.average_cadence,
        row.average_watts,
        row.average_heartrate,
        row.max_heartrate,
        row.pr_rank,
        row.kom_rank,
      ];
      const post = Object.fromEntries(
        fields.map((field, index) => [field, values[index]])
      );
      const prior = byExternalId.get(row.effort_external_id);
      if (!prior) {
        // An effort id filed under ANOTHER activity is a re-parent, not a crash
        // (#3194). This is the write that threw `UNIQUE constraint failed:
        // activity_segment_efforts.profile_id, …source, …external_id` and killed
        // the prod ride-detail backfill at 48 of 208 — for a fortnight, on every
        // retry, because the candidate order is stable.
        const elsewhere = findAnywhere.get(
          profileId,
          source,
          row.effort_external_id
        ) as { id: number } | undefined;
        if (elsewhere)
          reparent.run(activityId, ...values, elsewhere.id, profileId);
        else
          insert.run(
            profileId,
            activityId,
            source,
            row.effort_external_id,
            ...values
          );
      } else if (!fieldsEqual(prior, post, fields)) {
        update.run(...values, prior.id, profileId);
      }
    }
  }
}
