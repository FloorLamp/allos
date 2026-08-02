// Bulk corrections (issue #1603) — the IMPURE half.
//
// Auth-blind write core over the pure planner (lib/bulk-correction.ts): profileId
// first, never imports lib/auth — the Server Actions in
// app/(app)/data/bulk-correction-actions.ts own the gate. Apply runs in ONE
// writeTx and is compare-and-set: it re-reads the run under the write lock,
// re-plans, and refuses when the previewed (id, before) signature no longer
// matches (a sync can land mid-preview). The same transaction:
//
//   • sets the #133 EDIT LOCK (`edited = 1`) on every touched SOURCE-OWNED row —
//     otherwise the next Withings/Oura rolling-window push silently un-corrects
//     everything (manual rows have no source to be re-pushed from, so their flag
//     is left alone, matching lib/metric-readings.ts);
//   • snapshots the INVERSE into the existing `deleted_rows` store
//     (kind='bulk-correction', non-PHI label, JSON payload of {id, before, after}
//     plus whether THIS correction set each row's lock) — no new table, and ids
//     never recycle (AUTOINCREMENT everywhere) so id-keyed undo is sound. Like
//     every deleted_rows capture it is swept after 24h (sweepDeletedRows).
//
// Undo honors "undo inverts the side effects" (#200/#202): each row is restored
// with a guarded UPDATE (`… AND column = after`), so a row edited again since the
// correction is SKIPPED and reported, never clobbered — and `edited` is cleared
// only where this correction set it, so a previously hand-edited row keeps its
// lock.
//
// Every statement is a LITERAL with profile_id in its text (one per field, the
// lib/metric-readings.ts shape) so the profile-scoping scanner can read it.

import { db, writeTx } from "./db";
import { isEditLocked } from "./integrations/sync-log";
import {
  BULK_CORRECTION_KIND,
  bulkCorrectionLabel,
  correctionSignature,
  parseBulkCorrectionPayload,
  planCorrection,
  serializeBulkCorrectionPayload,
  type BulkCorrectionPayloadChange,
  type CorrectionFieldId,
  type CorrectionOp,
  type CorrectionSummary,
} from "./bulk-correction";

/** The selection: date range × source (null = manual rows, `source IS NULL`). */
export interface CorrectionFilter {
  from: string;
  to: string;
  source: string | null;
}

export interface BulkCorrectionRow {
  id: number;
  date: string;
  value: number;
  source: string | null;
  edited: boolean;
}

// One literal SELECT per field. `source IS ?` is SQLite's null-safe equality, so
// one statement serves both a provider source and the manual (NULL) bucket.
function rowSelect(field: CorrectionFieldId) {
  switch (field) {
    case "weight":
      return db.prepare(
        `SELECT id, date, weight_kg AS value, source, edited FROM body_metrics
          WHERE profile_id = ? AND weight_kg IS NOT NULL
            AND date >= ? AND date <= ? AND source IS ?
          ORDER BY date, id`
      );
    case "body-fat":
      return db.prepare(
        `SELECT id, date, body_fat_pct AS value, source, edited FROM body_metrics
          WHERE profile_id = ? AND body_fat_pct IS NOT NULL
            AND date >= ? AND date <= ? AND source IS ?
          ORDER BY date, id`
      );
    case "resting-hr":
      return db.prepare(
        `SELECT id, date, resting_hr AS value, source, edited FROM body_metrics
          WHERE profile_id = ? AND resting_hr IS NOT NULL
            AND date >= ? AND date <= ? AND source IS ?
          ORDER BY date, id`
      );
    case "hrv":
      return db.prepare(
        `SELECT id, date, value, source, edited FROM metric_samples
          WHERE profile_id = ? AND metric = 'hrv_ms'
            AND date >= ? AND date <= ? AND source IS ?
          ORDER BY date, id`
      );
    case "distance":
      return db.prepare(
        `SELECT id, date, distance_km AS value, source, edited FROM activities
          WHERE profile_id = ? AND distance_km IS NOT NULL
            AND date >= ? AND date <= ? AND source IS ?
          ORDER BY date, id`
      );
  }
}

// One literal apply-UPDATE per field. The #133 lock is only meaningful on a
// SOURCE-OWNED row (metric_samples' source is NOT NULL, so its lock is
// unconditional); a manual row's flag is left alone — the lib/metric-readings.ts
// CASE, verbatim.
function applyUpdate(field: CorrectionFieldId) {
  switch (field) {
    case "weight":
      return db.prepare(
        `UPDATE body_metrics
            SET weight_kg = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ?`
      );
    case "body-fat":
      return db.prepare(
        `UPDATE body_metrics
            SET body_fat_pct = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ?`
      );
    case "resting-hr":
      return db.prepare(
        `UPDATE body_metrics
            SET resting_hr = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ?`
      );
    case "hrv":
      return db.prepare(
        `UPDATE metric_samples SET value = ?, edited = 1
          WHERE id = ? AND profile_id = ? AND metric = 'hrv_ms'`
      );
    case "distance":
      return db.prepare(
        `UPDATE activities
            SET distance_km = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ?`
      );
  }
}

// One literal undo-UPDATE per field, guarded on the current value still equaling
// the correction's `after` (`… AND column = ?`) — the drift-skip is the WHERE
// clause, so a row edited since simply matches nothing (changes = 0) and is
// counted skipped. `edited` is cleared only when the bound lockSet flag says THIS
// correction set it.
function undoUpdate(field: CorrectionFieldId) {
  switch (field) {
    case "weight":
      return db.prepare(
        `UPDATE body_metrics
            SET weight_kg = ?, edited = CASE WHEN ? THEN 0 ELSE edited END
          WHERE id = ? AND profile_id = ? AND weight_kg = ?`
      );
    case "body-fat":
      return db.prepare(
        `UPDATE body_metrics
            SET body_fat_pct = ?, edited = CASE WHEN ? THEN 0 ELSE edited END
          WHERE id = ? AND profile_id = ? AND body_fat_pct = ?`
      );
    case "resting-hr":
      return db.prepare(
        `UPDATE body_metrics
            SET resting_hr = ?, edited = CASE WHEN ? THEN 0 ELSE edited END
          WHERE id = ? AND profile_id = ? AND resting_hr = ?`
      );
    case "hrv":
      return db.prepare(
        `UPDATE metric_samples
            SET value = ?, edited = CASE WHEN ? THEN 0 ELSE edited END
          WHERE id = ? AND profile_id = ? AND metric = 'hrv_ms' AND value = ?`
      );
    case "distance":
      return db.prepare(
        `UPDATE activities
            SET distance_km = ?, edited = CASE WHEN ? THEN 0 ELSE edited END
          WHERE id = ? AND profile_id = ? AND distance_km = ?`
      );
  }
}

/** The rows a filter selects, in canonical units, stable (date, id) order. */
export function readCorrectionRows(
  profileId: number,
  field: CorrectionFieldId,
  filter: CorrectionFilter
): BulkCorrectionRow[] {
  const rows = rowSelect(field).all(
    profileId,
    filter.from,
    filter.to,
    filter.source
  ) as {
    id: number;
    date: string;
    value: number;
    source: string | null;
    edited: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    value: r.value,
    source: r.source,
    edited: isEditLocked(r.edited),
  }));
}

/** One source option for the picker: which runs exist for a field, and when. */
export interface CorrectionSourceOption {
  source: string | null;
  count: number;
  minDate: string;
  maxDate: string;
}

export type CorrectionSourcesByField = Record<
  CorrectionFieldId,
  CorrectionSourceOption[]
>;

type SourceRow = {
  source: string | null;
  count: number;
  minDate: string;
  maxDate: string;
};

/**
 * The source runs available per field, for the picker (rows per source with the
 * date span they cover). Cheap GROUP BY per store.
 */
export function listCorrectionSources(
  profileId: number
): CorrectionSourcesByField {
  const weight = db
    .prepare(
      `SELECT source, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
         FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL
        GROUP BY source ORDER BY count DESC`
    )
    .all(profileId) as SourceRow[];
  const bodyFat = db
    .prepare(
      `SELECT source, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
         FROM body_metrics WHERE profile_id = ? AND body_fat_pct IS NOT NULL
        GROUP BY source ORDER BY count DESC`
    )
    .all(profileId) as SourceRow[];
  const restingHr = db
    .prepare(
      `SELECT source, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
         FROM body_metrics WHERE profile_id = ? AND resting_hr IS NOT NULL
        GROUP BY source ORDER BY count DESC`
    )
    .all(profileId) as SourceRow[];
  const hrv = db
    .prepare(
      `SELECT source, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
         FROM metric_samples WHERE profile_id = ? AND metric = 'hrv_ms'
        GROUP BY source ORDER BY count DESC`
    )
    .all(profileId) as SourceRow[];
  const distance = db
    .prepare(
      `SELECT source, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
         FROM activities WHERE profile_id = ? AND distance_km IS NOT NULL
        GROUP BY source ORDER BY count DESC`
    )
    .all(profileId) as SourceRow[];
  return {
    weight,
    "body-fat": bodyFat,
    "resting-hr": restingHr,
    hrv,
    distance,
  };
}

export type BulkCorrectionApplyOutcome =
  | {
      ok: true;
      undoId: number;
      applied: number;
      /** Rows whose #133 edit lock THIS correction set. */
      locked: number;
      summary: CorrectionSummary;
    }
  | { ok: false; error: "drift" | "empty" | "out-of-range" };

/**
 * Apply a correction in ONE writeTx, compare-and-set against the previewed
 * signature (see the header). Returns typed outcomes only — the caller renders
 * them; nothing here confirms success unconditionally.
 */
export function applyBulkCorrection(
  profileId: number,
  field: CorrectionFieldId,
  filter: CorrectionFilter,
  op: CorrectionOp,
  expectedSignature: string
): BulkCorrectionApplyOutcome {
  return writeTx((): BulkCorrectionApplyOutcome => {
    const rows = readCorrectionRows(profileId, field, filter);
    const plan = planCorrection(field, rows, op);
    if (!plan.ok) return { ok: false, error: "out-of-range" };
    if (plan.changes.length === 0 || plan.summary === null)
      return { ok: false, error: "empty" };
    // The #467 compare-and-set: the run under the write lock must still be the
    // run the user previewed — any drift (a sync upsert, a concurrent edit, a
    // new row in the range) refuses the whole write.
    if (correctionSignature(plan.changes) !== expectedSignature)
      return { ok: false, error: "drift" };

    const byId = new Map(rows.map((r) => [r.id, r]));
    const update = applyUpdate(field);
    const payloadChanges: BulkCorrectionPayloadChange[] = [];
    let locked = 0;
    for (const change of plan.changes) {
      update.run(change.after, change.id, profileId);
      const row = byId.get(change.id)!;
      // metric_samples' source is NOT NULL; for the others the lock only lands
      // on a source-owned row (the UPDATE's CASE) — mirror that decision here so
      // undo knows exactly which locks were OURS to clear.
      const lockSet = row.source !== null && !row.edited;
      if (lockSet) locked++;
      payloadChanges.push({
        id: change.id,
        before: change.before,
        after: change.after,
        lockSet,
      });
    }

    const undoId = Number(
      db
        .prepare(
          `INSERT INTO deleted_rows (profile_id, kind, label, payload) VALUES (?, ?, ?, ?)`
        )
        .run(
          profileId,
          BULK_CORRECTION_KIND,
          bulkCorrectionLabel(field, plan.changes.length),
          serializeBulkCorrectionPayload(field, payloadChanges)
        ).lastInsertRowid
    );
    return {
      ok: true,
      undoId,
      applied: plan.changes.length,
      locked,
      summary: plan.summary,
    };
  });
}

export type BulkCorrectionUndoOutcome =
  | { ok: true; restored: number; skipped: number }
  | { ok: false; error: "not-found" | "invalid" };

/**
 * Undo a bulk correction: restore `before` only where the current value still
 * equals `after` (rows edited since are skipped and reported, never clobbered),
 * clear `edited` only on rows where this correction set it, and consume the
 * holding row — all in one writeTx. A second undo of the same token finds
 * nothing and reports not-found.
 */
export function undoBulkCorrection(
  profileId: number,
  undoId: number
): BulkCorrectionUndoOutcome {
  return writeTx((): BulkCorrectionUndoOutcome => {
    const held = db
      .prepare(
        `SELECT kind, payload FROM deleted_rows WHERE id = ? AND profile_id = ?`
      )
      .get(undoId, profileId) as { kind: string; payload: string } | undefined;
    if (!held || held.kind !== BULK_CORRECTION_KIND)
      return { ok: false, error: "not-found" };
    const payload = parseBulkCorrectionPayload(held.payload);
    if (!payload) return { ok: false, error: "invalid" };

    const update = undoUpdate(payload.field);
    let restored = 0;
    let skipped = 0;
    for (const c of payload.changes) {
      const info = update.run(
        c.before,
        c.lockSet ? 1 : 0,
        c.id,
        profileId,
        c.after
      );
      if (info.changes > 0) restored++;
      else skipped++;
    }
    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
    return { ok: true, restored, skipped };
  });
}
