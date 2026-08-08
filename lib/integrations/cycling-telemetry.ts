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

export type CyclingStreamKey = (typeof STRAVA_STREAM_KEYS)[number];

export interface ProviderStream {
  data: unknown[];
  original_size?: number;
  resolution?: string;
  series_type?: string;
}

export type CyclingStreams = Partial<Record<CyclingStreamKey, ProviderStream>>;

export interface NormCyclingTelemetry {
  external_id: string;
  streams: CyclingStreams;
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

export function hasCyclingStreamDetails(
  profileId: number,
  externalId: string,
  source: string
): boolean {
  const row = db
    .prepare(
      `SELECT t.streams_json
         FROM activity_telemetry t
         JOIN activities a
           ON a.id = t.activity_id AND a.profile_id = t.profile_id
        WHERE t.profile_id = ? AND a.external_id = ? AND t.source = ?`
    )
    .get(profileId, externalId, source) as
    { streams_json: string | null } | undefined;
  if (!row?.streams_json) return false;
  try {
    const streams = JSON.parse(row.streams_json) as Record<string, unknown>;
    return Object.keys(streams).length > 0;
  } catch {
    return false;
  }
}

export function upsertCyclingTelemetry(
  profileId: number,
  rows: NormCyclingTelemetry[],
  source: string
): UpsertCounts {
  const find = db.prepare(
    `SELECT streams_json, ftp_w, heart_rate_zones_json, power_zones_json, snapshot_at
       FROM activity_telemetry
      WHERE profile_id = ? AND activity_id = ? AND source = ?`
  );
  const upsert = db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, ftp_w,
        heart_rate_zones_json, power_zones_json, snapshot_at,
        stream_summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, activity_id, source) DO UPDATE SET
       streams_json = excluded.streams_json,
       ftp_w = excluded.ftp_w,
       heart_rate_zones_json = excluded.heart_rate_zones_json,
       power_zones_json = excluded.power_zones_json,
       snapshot_at = excluded.snapshot_at,
       stream_summary_json = excluded.stream_summary_json`
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
      typeof incoming | undefined;
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
    const equal =
      !!prior &&
      prior.streams_json === post.streams_json &&
      prior.ftp_w === post.ftp_w &&
      prior.heart_rate_zones_json === post.heart_rate_zones_json &&
      prior.power_zones_json === post.power_zones_json;
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
        // The cycling overview reads THIS instead of parsing every ride's streams
        // on every page load (#2292). It is a pure function of the two columns
        // written beside it, so it is derived from `post` — the values actually
        // stored — and never from `incoming`, which a partial pull may have left
        // empty. An "unchanged" disposition writes nothing, which is correct: the
        // stored summary already describes those same bytes. A LOGIC change (a new
        // curve duration) invalidates it by signature instead, and the boot
        // reconcile re-derives it.
        serializeCyclingStreamSummary(
          summarizeCyclingStreams(post.streams_json, post.power_zones_json)
        )
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
  for (const [externalId, group] of groupedChildren(rows, parentExternalIds)) {
    const activityId = resolveActivity(profileId, externalId);
    if (activityId == null) continue;
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
  for (const [externalId, group] of groupedChildren(rows, parentExternalIds)) {
    const activityId = resolveActivity(profileId, externalId);
    if (activityId == null) continue;
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
