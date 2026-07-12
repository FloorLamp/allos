// PURE natural-key composition for the re-import tombstone (issues #507/#508) — the
// "third lock" symmetric with #133's `edited`. When the user MERGES away or DELETES a
// source-owned row (a Strava/Health Connect activity, an imported scale reading, an
// imported vital), the next rolling-window resync would look the row up by its natural
// key, find nothing, and re-insert it — silently undoing the user's action. A
// tombstone records the deleted row's natural key so every keyed upsert can skip the
// re-insert (and count it honestly). This module owns ONLY the key math + the
// row->tombstone derivation, with no `@/lib/db` import, so it stays in the pure unit
// tier (lib/__tests__); the DB load/write/remove ops live in the sibling tombstones.ts.

// The tables whose keyed upserts consult the tombstone. Each maps to a natural key the
// upsert dedups on (see lib/integrations/normalize.ts): activities/medical_records by
// external_id, body_metrics by (date, source), metric_samples by
// (metric, source, start_time, end_time), hr_minutes by (ts, source).
export const TOMBSTONE_TABLES = [
  "activities",
  "body_metrics",
  "medical_records",
  "metric_samples",
  "hr_minutes",
] as const;
export type TombstoneTable = (typeof TOMBSTONE_TABLES)[number];

// A separator that cannot occur inside any of the composed field values (dates,
// source ids like 'health-connect', ISO instants, metric names) — the ASCII unit
// separator control char — so the joined multi-field key is unambiguous and stable.
const SEP = String.fromCharCode(0x1f);

// activities / medical_records dedup on external_id alone (it already encodes the
// source, e.g. 'strava:123' / 'health-connect:<canonical>:<time>'), so the external_id
// IS the natural key.
export function activityTombstoneKey(externalId: string): string {
  return externalId;
}
export function medicalRecordTombstoneKey(externalId: string): string {
  return externalId;
}

// body_metrics dedups on (date, source) — one imported row per source per day.
export function bodyMetricTombstoneKey(date: string, source: string): string {
  return `${date}${SEP}${source}`;
}

// metric_samples dedups on (metric, source, start_time, end_time).
export function metricSampleTombstoneKey(
  metric: string,
  source: string,
  startTime: string,
  endTime: string
): string {
  return [metric, source, startTime, endTime].join(SEP);
}

// hr_minutes dedups on (ts, source).
export function hrMinuteTombstoneKey(ts: string, source: string): string {
  return `${ts}${SEP}${source}`;
}

// Derive the tombstone (table, key) for a captured/deleted ROOT row of an undoable
// kind's owned table, or null when the row is NOT source-owned (a manual/document row
// the rolling-window sync never re-creates -> no tombstone needed). Used by
// captureDelete (write), restoreDeletedRow (remove on undo), and the Review-resolver
// merges. Only the three undoable roots that a sync can resurrect are covered
// (activities, body_metrics, medical_records); intake_items and other roots aren't
// source-keyed, so they return null. Pure.
export function importTombstoneForRow(
  ownedTable: string,
  row: Record<string, unknown>
): { table: TombstoneTable; key: string } | null {
  switch (ownedTable) {
    case "activities": {
      const ext = row.external_id;
      return typeof ext === "string" && ext
        ? { table: "activities", key: activityTombstoneKey(ext) }
        : null;
    }
    case "medical_records": {
      const ext = row.external_id;
      return typeof ext === "string" && ext
        ? { table: "medical_records", key: medicalRecordTombstoneKey(ext) }
        : null;
    }
    case "body_metrics": {
      const src = row.source;
      const date = row.date;
      return typeof src === "string" && src && typeof date === "string" && date
        ? { table: "body_metrics", key: bodyMetricTombstoneKey(date, src) }
        : null;
    }
    default:
      return null;
  }
}
