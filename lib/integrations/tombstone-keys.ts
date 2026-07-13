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
// (metric, source, start_time, end_time).
//
// `hr_minutes` was covered on the READ side historically but never had a tombstone
// WRITER (#653): its dataset is browse/export-only (`deletable: false` in lib/export.ts)
// and it has no per-row delete path — the only mutation besides a sync upsert is the
// timezone re-import sweep (which must NOT be suppressed, or the re-import is lost) and
// a whole-profile delete. So there is no deletion that a sync could resurrect, and the
// read-side entry was dormant coverage implying a protection that didn't exist. It is
// intentionally NOT in this set; if hr_minutes ever gains a per-row delete affordance,
// re-add it here AND emit a tombstone on that delete path (see hrMinuteTombstoneKey).
export const TOMBSTONE_TABLES = [
  "activities",
  "body_metrics",
  "medical_records",
  "metric_samples",
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

// hr_minutes dedups on (ts, source). Retained as pure key math for a POSSIBLE future
// per-row HR delete; hr_minutes is NOT currently in TOMBSTONE_TABLES (no delete path —
// see the note there), so nothing writes/consults this today.
export function hrMinuteTombstoneKey(ts: string, source: string): string {
  return `${ts}${SEP}${source}`;
}

// Derive the tombstone (table, key) for a captured/deleted row of a covered table,
// or null when the row is NOT source-owned (a manual/document row the rolling-window
// sync never re-creates -> no tombstone needed). Used by captureDelete (write) and
// restoreDeletedRow (remove on undo) for the undoable roots (activities, body_metrics,
// medical_records), the Review-resolver merges, and the Data → Manage bulk delete for
// metric_samples (#653) — its rows are independently deletable but have no undoable
// parent, so their delete emits a tombstone here directly. Tables the sync can't
// resurrect (intake_items, etc.) return null. Pure.
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
    case "metric_samples": {
      // metric_samples dedups on (metric, source, start_time, end_time) — all four
      // must be present for a stable, sync-matching key. A row missing any of them
      // isn't a source-owned re-import target, so no tombstone.
      const metric = row.metric;
      const src = row.source;
      const start = row.start_time;
      const end = row.end_time;
      return typeof metric === "string" &&
        metric &&
        typeof src === "string" &&
        src &&
        typeof start === "string" &&
        start &&
        typeof end === "string" &&
        end
        ? {
            table: "metric_samples",
            key: metricSampleTombstoneKey(metric, src, start, end),
          }
        : null;
    }
    default:
      return null;
  }
}
