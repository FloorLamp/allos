// Health Connect deletions (FP-9634). A record the phone deleted arrives as its record
// id in the push's `deleted` list. Stored rows are keyed by natural keys, not record
// ids, so every record that states `metadata.id` leaves a ledger row per stored row it
// wrote (`health_connect_record_refs`); a deletion reads the ledger, removes those rows
// and drops the ledger rows. Idempotent: a replayed or unknown id finds nothing.
//
// - No tombstone: the record is gone at the source, and an app that re-writes it (a
//   corrected sleep session at the same start) must land again.
// - A hand-edited row stays (the user owns it) and is counted `edited`.
// - Activities and clinical readings go through `captureDelete`, which detaches their
//   inbound links and keeps an undo copy; its tombstone is removed again.
// - A body measure is cleared only when the deleted record is the reading the day
//   reports (its instant matches); the row goes when no measure is left.
// - A heart-rate record removes its minutes span; a CGM point re-derives its day.

import { db } from "@/lib/db";
import { captureDelete } from "@/lib/undo-delete-db";
import { removeGlucoseTracePoint } from "@/lib/glucose-trace-db";
import { removeImportTombstoneForRow } from "./tombstones";
import { MEASURES } from "./ingest-timezone-reconcile";
import { isEditLocked } from "./sync-log";
import type {
  HealthConnectRecordRef,
  HealthConnectRefTarget,
} from "./health-connect";

export interface HealthConnectDeletions {
  // Deleted ids that matched a ledger entry.
  records: number;
  // Deleted ids with no ledger entry: unknown, already applied, or sent without id.
  unmatched: number;
  // Stored rows (or measures) removed.
  removed: number;
  // Rows kept because the user edited them.
  edited: number;
}

// Remember which rows each record id wrote. Runs inside the caller's transaction.
export function recordHealthConnectRefs(
  profileId: number,
  refs: readonly HealthConnectRecordRef[]
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO health_connect_record_refs
       (profile_id, record_id, target, natural_key) VALUES (?, ?, ?, ?)`
  );
  for (const r of refs)
    insert.run(profileId, r.recordId, r.target, JSON.stringify(r.key));
}

type Removal = "removed" | "edited" | "absent";

// Remove a captured activity or clinical reading the source deleted.
function removeCaptured(
  profileId: number,
  table: "activities" | "medical_records",
  kind: "activity" | "clinical-observation",
  externalId: string
): Removal {
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE profile_id = ? AND external_id = ?`)
    .get(profileId, externalId) as Record<string, unknown> | undefined;
  if (!row) return "absent";
  if (isEditLocked(row.edited as number | null)) return "edited";
  if (captureDelete(kind, profileId, row.id as number) === null)
    return "absent";
  removeImportTombstoneForRow(profileId, table, row);
  return "removed";
}

function removeMetricSample(
  profileId: number,
  source: string,
  [metric, origin, startedAt]: string[]
): Removal {
  const row = db
    .prepare(
      `SELECT id, edited FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ?
          AND started_at = ?`
    )
    .get(profileId, metric, source, origin || null, startedAt) as
    { id: number; edited: number | null } | undefined;
  if (!row) return "absent";
  if (isEditLocked(row.edited)) return "edited";
  db.prepare("DELETE FROM metric_samples WHERE id = ? AND profile_id = ?").run(
    row.id,
    profileId
  );
  return "removed";
}

function removeBodyMeasure(
  profileId: number,
  source: string,
  [column, date, instant]: string[]
): Removal {
  const measure = MEASURES.find((m) => m.column === column);
  if (!measure) return "absent";
  const row = db
    .prepare(
      `SELECT edited, weight_kg, body_fat_pct, resting_hr, ${measure.instant} AS at
         FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?
        ORDER BY id LIMIT 1`
    )
    .get(profileId, date, source) as
    (Record<string, number | null> & { at: string | null }) | undefined;
  if (!row || row[measure.column] == null || row.at !== instant)
    return "absent";
  if (isEditLocked(row.edited)) return "edited";
  const holdsMore = MEASURES.some(
    (m) => m.column !== measure.column && row[m.column] != null
  );
  if (holdsMore)
    db.prepare(
      `UPDATE body_metrics SET ${measure.column} = NULL, ${measure.instant} = NULL
        WHERE profile_id = ? AND date = ? AND source IS ?`
    ).run(profileId, date, source);
  else
    db.prepare(
      `DELETE FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?`
    ).run(profileId, date, source);
  return "removed";
}

function removeRef(
  profileId: number,
  source: string,
  target: HealthConnectRefTarget,
  key: string[]
): Removal {
  switch (target) {
    case "metric_samples":
      return removeMetricSample(profileId, source, key);
    case "body_metrics":
      return removeBodyMeasure(profileId, source, key);
    case "medical_records":
      return removeCaptured(
        profileId,
        "medical_records",
        "clinical-observation",
        key[0]
      );
    case "activities":
      return removeCaptured(profileId, "activities", "activity", key[0]);
    case "glucose_trace": {
      const [origin, ts] = key;
      const sources = origin ? [`${source}:${origin}`, source] : [source];
      return removeGlucoseTracePoint(profileId, sources, ts) > 0
        ? "removed"
        : "absent";
    }
    case "hr_minutes":
      return db
        .prepare(
          `DELETE FROM hr_minutes
            WHERE profile_id = ? AND source = ? AND ts >= ? AND ts <= ?`
        )
        .run(profileId, source, key[0], key[1]).changes > 0
        ? "removed"
        : "absent";
  }
}

// Apply the push's deleted record ids. Runs inside the caller's transaction.
export function applyHealthConnectDeletions(
  profileId: number,
  source: string,
  recordIds: readonly string[]
): HealthConnectDeletions {
  const out: HealthConnectDeletions = {
    records: 0,
    unmatched: 0,
    removed: 0,
    edited: 0,
  };
  const findRefs = db.prepare(
    `SELECT target, natural_key FROM health_connect_record_refs
      WHERE profile_id = ? AND record_id = ?`
  );
  const dropRefs = db.prepare(
    `DELETE FROM health_connect_record_refs WHERE profile_id = ? AND record_id = ?`
  );
  for (const recordId of new Set(recordIds)) {
    const refs = findRefs.all(profileId, recordId) as {
      target: HealthConnectRefTarget;
      natural_key: string;
    }[];
    if (refs.length === 0) {
      out.unmatched++;
      continue;
    }
    out.records++;
    for (const ref of refs) {
      const result = removeRef(
        profileId,
        source,
        ref.target,
        JSON.parse(ref.natural_key) as string[]
      );
      if (result === "removed") out.removed++;
      else if (result === "edited") out.edited++;
    }
    dropRefs.run(profileId, recordId);
  }
  return out;
}
