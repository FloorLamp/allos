// THE READING WRITE CORE (#2032, phase 2 of #1997).
//
// One core executes the placement decision that `lib/reading-placement.ts` states, and
// one contract edits and deletes a reading by the row it IS rather than by the surface
// that is showing it. Surfaces stop naming a table.
//
// AUTH-BLIND, `profileId` FIRST, no `lib/auth` import — the Server Actions in
// `app/(app)/trends/reading-actions.ts` (and every future caller) own the write gate,
// the validation and the unit conversion. Every statement filters on `profile_id`, so a
// row id belonging to another profile is a `not-found` no-op rather than a cross-profile
// write.
//
// IT SITS ON THE OBSERVATION SUBSTRATE, NOT BESIDE IT (#944):
//   • the #133 edit lock is read ONLY through `isEditLocked`, and it holds out a
//     SOURCE-OWNED re-push — never the user's own correction (see `recordReading`);
//   • the inserted/updated/unchanged split is classified by `classifyUpsert` and bumped
//     ONLY by `tallyUpsert`;
//   • deletes of source-owned rows write the #507/#508 re-import tombstone, or go
//     through `captureDelete`, which writes it and makes the delete undoable.
//
// NO SCHEMA CHANGE, and `medical_records` stays the clinical record: writes ROUTE to it,
// nothing here restructures it. Phase 3 (the physical merge) is a separate, later
// decision.

import { db, writeTx } from "./db";
import {
  classifyUpsert,
  isEditLocked,
  tallyUpsert,
  type UpsertCounts,
  type UpsertDisposition,
} from "./integrations/sync-log";
import { writeImportTombstoneForRow } from "./integrations/tombstones";
import { captureDelete } from "./undo-delete-db";
import { addCanonicalNames, reconcileFlags } from "./queries";
import { placeReading, type ReadingTarget } from "./reading-placement";
import { readingSourceFor, type ReadingProvenance } from "./reading-model";
import type { MedicalCategory } from "./types";
import type { BodyMetricColumn } from "./metric-readings";

// ---- body_metrics statements ----------------------------------------------
//
// body_metrics is the one store whose COLUMN varies by reading, and interpolating it
// into the SQL would make statements the profile-scoping scanner cannot read (it
// verifies `profile_id` in LITERAL prepare() text). So each column gets its own literal
// statement, switched here — the same deliberate verbosity the read layer keeps.

// The #133 lock is only meaningful on a SOURCE-OWNED row (the keyed upsert dedups on
// (date, source)); a manual row has no source to be re-pushed from, so its flag is left
// alone — the same CASE the medical record editor uses.
function bodyMetricUpdate(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics
            SET weight_kg = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND weight_kg IS NOT NULL`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics
            SET body_fat_pct = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND body_fat_pct IS NOT NULL`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics
            SET resting_hr = ?, edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
          WHERE id = ? AND profile_id = ? AND resting_hr IS NOT NULL`
      );
  }
}

// Clear ONE measure off a shared row (see deleteReadingAt).
function bodyMetricClear(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics SET weight_kg = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics SET body_fat_pct = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics SET resting_hr = NULL, edited = 1
          WHERE id = ? AND profile_id = ?`
      );
  }
}

// Insert the day's row carrying ONE measure. The other two columns are left NULL —
// body_metrics is wide, and a reading of one quantity says nothing about the others.
function bodyMetricInsert(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `INSERT INTO body_metrics (date, weight_kg, source, profile_id) VALUES (?, ?, ?, ?)`
      );
    case "body_fat_pct":
      return db.prepare(
        `INSERT INTO body_metrics (date, body_fat_pct, source, profile_id) VALUES (?, ?, ?, ?)`
      );
    case "resting_hr":
      return db.prepare(
        `INSERT INTO body_metrics (date, resting_hr, source, profile_id) VALUES (?, ?, ?, ?)`
      );
  }
}

// Write ONE measure onto an existing day row, leaving the others alone — which is what
// makes "body fat and resting HR entered in one sitting" land on one row, and what stops
// a resting-HR write from blanking that day's weight.
//
// Deliberately NOT `ON CONFLICT(profile_id, date, source)`: the unique index treats two
// NULL sources as distinct, so a hand-entered row (source NULL) would never conflict and
// the upsert would quietly grow a second row per day. Find-then-write answers the same
// for both, which is the only version that is correct for the manual path.
function bodyMetricSet(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `UPDATE body_metrics SET weight_kg = ? WHERE id = ? AND profile_id = ?`
      );
    case "body_fat_pct":
      return db.prepare(
        `UPDATE body_metrics SET body_fat_pct = ? WHERE id = ? AND profile_id = ?`
      );
    case "resting_hr":
      return db.prepare(
        `UPDATE body_metrics SET resting_hr = ? WHERE id = ? AND profile_id = ?`
      );
  }
}

function bodyMetricFind(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `SELECT id, edited, weight_kg AS value FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
      );
    case "body_fat_pct":
      return db.prepare(
        `SELECT id, edited, body_fat_pct AS value FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
      );
    case "resting_hr":
      return db.prepare(
        `SELECT id, edited, resting_hr AS value FROM body_metrics
          WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
      );
  }
}

// ---- recordReading: the placement-deciding write --------------------------

/** One dated reading offered to the write core, keyed by IDENTITY rather than store. */
export interface ReadingWriteInput {
  /** The canonical name of the quantity — what the placement policy decides on. */
  name: string;
  /** In the identity's canonical unit; the boundary converted already. */
  value: number;
  unit: string;
  /** The profile-local day. */
  date: string;
  /** The absolute instant, for the store that records one (`metric_samples`). */
  measuredAt?: string | null;
  /** The row's `source` stamp: an integration id, 'manual', `document:<id>`, or null. */
  source?: string | null;
  notes?: string | null;
  /** The clinical classification an observation row carries. Ignored by the streams. */
  category?: MedicalCategory;
  /** Clinical provenance. Its PRESENCE forces the observation store (clause 2). */
  provenance?: ReadingProvenance;
}

export type ReadingRecordOutcome =
  | {
      ok: true;
      store: ReadingTarget["store"];
      rowId: number;
      disposition: UpsertDisposition;
    }
  | {
      ok: false;
      error: "unplaceable" | "invalid" | "edit-locked" | "document-import";
    };

function hasProvenance(p: ReadingProvenance | undefined): boolean {
  return !!p && Object.keys(p).length > 0;
}

/**
 * Record one reading. The CORE decides which physical store it lands in; the caller
 * says what quantity it is.
 *
 * The edit lock (#133) holds out a SOURCE-OWNED re-push only. A write stamped with an
 * integration id (or a `document:<id>` import stamp) that lands on a row the user has
 * hand-corrected is refused with `edit-locked` — that is the whole point of the lock.
 * A `manual` write is the USER, and a user may always correct their own row; refusing
 * there would mean a person could not re-enter a value they had previously fixed.
 *
 * A DOCUMENT-linked reading is refused with `document-import`: those rows belong to the
 * import footprint and must be written by `persistDocumentImport`, so that clear,
 * reassign and the extracted counts can still see them. Clause 2 of the placement policy
 * is unaffected — a document still forces the observation store, the core simply is not
 * the thing that writes it.
 *
 * Dispositions are classified by `classifyUpsert` so the accounting a sync reports is
 * the accounting this core produces. An OBSERVATION is always `inserted`: a
 * `medical_records` row is a dated clinical EVENT, and a second same-day temperature is
 * a fever curve (#800/#843), not a correction of the first.
 */
export function recordReading(
  profileId: number,
  input: ReadingWriteInput
): ReadingRecordOutcome {
  if (!Number.isFinite(input.value)) return { ok: false, error: "invalid" };
  if (!input.date.trim()) return { ok: false, error: "invalid" };
  const decision = placeReading({
    name: input.name,
    provenance: hasProvenance(input.provenance),
  });
  if (decision.refused) return { ok: false, error: "unplaceable" };
  const placement = decision.placed;
  const sourceKey = input.source ?? null;
  // Whether this write is the SOURCE re-pushing rather than the user typing — the one
  // question the #133 lock is about.
  const kind = readingSourceFor({ sourceKey });
  const sourceOwned = kind === "wearable" || kind === "import";

  return writeTx(() => {
    switch (placement.table) {
      case "body_metrics": {
        const found = bodyMetricFind(placement.column).get(
          profileId,
          input.date,
          sourceKey
        ) as
          | { id: number; edited: number | null; value: number | null }
          | undefined;
        if (found && sourceOwned && isEditLocked(found.edited)) {
          return { ok: false, error: "edit-locked" } as const;
        }
        const disposition = classifyUpsert(
          !!found && found.value != null,
          found?.value === input.value
        );
        if (found) {
          if (disposition !== "unchanged") {
            bodyMetricSet(placement.column).run(
              input.value,
              found.id,
              profileId
            );
          }
          return {
            ok: true,
            store: "body_metrics",
            rowId: found.id,
            disposition,
          } as const;
        }
        const info = bodyMetricInsert(placement.column).run(
          input.date,
          input.value,
          sourceKey,
          profileId
        );
        return {
          ok: true,
          store: "body_metrics",
          rowId: Number(info.lastInsertRowid),
          disposition,
        } as const;
      }
      case "metric_samples": {
        // The natural key the tall store dedups on: (profile_id, metric, source,
        // origin, start_time). A reading with no stated instant is filed at the day's
        // midnight, so a re-entry corrects rather than duplicates.
        const ts = input.measuredAt ?? `${input.date}T00:00:00`;
        // `metric_samples.source` is NOT NULL, so an unstamped write is the user's own:
        // 'manual', the same stamp every hand-entered sample already carries.
        const sampleSource = sourceKey ?? "manual";
        const found = db
          .prepare(
            `SELECT id, edited, value FROM metric_samples
              WHERE profile_id = ? AND metric = ? AND source IS ? AND start_time = ?
              ORDER BY id LIMIT 1`
          )
          .get(profileId, placement.metric, sampleSource, ts) as
          { id: number; edited: number | null; value: number } | undefined;
        if (found && sourceOwned && isEditLocked(found.edited)) {
          return { ok: false, error: "edit-locked" } as const;
        }
        const disposition = classifyUpsert(
          !!found,
          found?.value === input.value
        );
        if (found) {
          db.prepare(
            `UPDATE metric_samples SET value = ?, date = ?
              WHERE id = ? AND profile_id = ?`
          ).run(input.value, input.date, found.id, profileId);
          return {
            ok: true,
            store: "metric_samples",
            rowId: found.id,
            disposition,
          } as const;
        }
        const info = db
          .prepare(
            `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            profileId,
            sampleSource,
            placement.metric,
            input.date,
            ts,
            ts,
            input.value
          );
        return {
          ok: true,
          store: "metric_samples",
          rowId: Number(info.lastInsertRowid),
          disposition,
        } as const;
      }
      case "medical_records": {
        const p = input.provenance;
        // A DOCUMENT-derived row is the import pipeline's, not this core's. Binding a
        // `document_id` here would create a row that clear / reassign / extracted-count
        // cannot see — the import-footprint contract (#453/#422), which
        // `persistDocumentImport` is the single entry point for. So the core REFUSES
        // rather than writing a row with the link quietly dropped: a placement policy
        // may decide which store a reading belongs in, it may not decide to lose its
        // document.
        if (p?.documentId != null) {
          return { ok: false, error: "document-import" } as const;
        }
        // The name the SOURCE printed, when it differs from the canonical — the row's
        // `name` column has always carried that, with the canonical beside it.
        const reported = p?.reportedName?.trim();
        const info = db
          .prepare(
            `INSERT INTO medical_records
               (profile_id, date, category, name, value, value_num, unit, canonical_name,
                source, external_id, notes, reference_range, encounter_id, provider_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
          )
          .run(
            profileId,
            input.date,
            input.category ?? "lab",
            reported || placement.canonical,
            String(input.value),
            input.value,
            input.unit,
            placement.canonical,
            sourceKey,
            input.notes ?? null,
            p?.reportedRange ?? null,
            p?.encounterId ?? null,
            p?.providerId ?? null
          );
        const rowId = Number(info.lastInsertRowid);
        addCanonicalNames([placement.canonical]);
        // A flag is a FUNCTION of the value against the canonical range (#221), so it is
        // derived through the same reconcile every other observation writer calls —
        // never a second flag engine here.
        reconcileFlags(profileId, [rowId]);
        return {
          ok: true,
          store: "medical_records",
          rowId,
          disposition: "inserted",
        } as const;
      }
    }
  });
}

/**
 * Record several readings and report the shared upsert accounting. The counts are bumped
 * ONLY through `tallyUpsert`, so a caller's inserted/updated/unchanged split is the same
 * split every sync reports.
 */
export function recordReadings(
  profileId: number,
  inputs: readonly ReadingWriteInput[],
  counts: UpsertCounts
): ReadingRecordOutcome[] {
  const out: ReadingRecordOutcome[] = [];
  for (const input of inputs) {
    const outcome = recordReading(profileId, input);
    out.push(outcome);
    if (outcome.ok) tallyUpsert(counts, outcome.disposition);
    else if (outcome.error === "edit-locked") counts.edited++;
  }
  return out;
}

// ---- The editability contract ---------------------------------------------

export type ReadingWriteOutcome =
  { ok: true } | { ok: false; error: "not-found" | "derived" | "invalid" };

export interface ReadingDeleteOutcome {
  ok: boolean;
  /** Present when the delete went through the undo holding store. */
  undoId: number | null;
}

/**
 * Correct one reading's value, in STORED units, by the row it IS.
 *
 * The generalization phase 2 exists for: the caller hands over a `ReadingTarget` taken
 * from the row, so a clinical observation folded onto a stream metric's page is
 * corrected in place instead of being marked read-only because the page's slug names a
 * different table.
 *
 * `medical_records` scopes by #482 IDENTITY through the `biomarker_family()` SQL
 * function rather than by an exact canonical string, so an aliased spelling of the same
 * analyte is the same target — "which identity am I", not "which table am I".
 */
export function updateReadingAt(
  profileId: number,
  target: ReadingTarget,
  value: number
): ReadingWriteOutcome {
  if (!Number.isFinite(value)) return { ok: false, error: "invalid" };
  return writeTx(() => {
    switch (target.store) {
      case "body_metrics": {
        const info = bodyMetricUpdate(target.column).run(
          value,
          target.id,
          profileId
        );
        return info.changes > 0
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
      case "metric_samples": {
        const info = db
          .prepare(
            `UPDATE metric_samples SET value = ?, edited = 1
              WHERE id = ? AND profile_id = ? AND metric = ?`
          )
          .run(value, target.id, profileId, target.metric);
        return info.changes > 0
          ? ({ ok: true } as const)
          : ({ ok: false, error: "not-found" } as const);
      }
      case "medical_records": {
        const info = db
          .prepare(
            `UPDATE medical_records
                SET value = ?, value_num = ?,
                    -- Same #133 lock the record editor applies: an imported reading
                    -- corrected here must survive the next rolling window.
                    edited = CASE WHEN external_id IS NOT NULL THEN 1 ELSE edited END
              WHERE id = ? AND profile_id = ?
                AND biomarker_family(canonical_name) = biomarker_family(?) COLLATE NOCASE`
          )
          .run(String(value), value, target.id, profileId, target.identity);
        if (info.changes === 0)
          return { ok: false, error: "not-found" } as const;
        // A reading's out-of-range flag is a FUNCTION of its value, so a corrected value
        // re-derives it through the SAME reconcileFlags the record editor calls (#221) —
        // otherwise an edited-down blood pressure keeps its old "high".
        reconcileFlags(profileId, [target.id]);
        return { ok: true } as const;
      }
    }
  });
}

/**
 * Delete one reading by the row it IS. Where an undoable capture already exists for the
 * store's root (`body_metrics`, `medical_records`) it goes through `captureDelete`,
 * which writes the re-import tombstone and makes the delete restorable from the toast.
 * The stores with no undoable root delete directly, capturing their tombstone pre-image
 * FIRST — the #653 pattern, without which the next rolling-window sync would simply
 * re-insert the row the user just removed.
 */
export function deleteReadingAt(
  profileId: number,
  target: ReadingTarget
): ReadingDeleteOutcome {
  switch (target.store) {
    case "body_metrics": {
      // A body_metrics ROW carries up to three measures; deleting the row for a body-fat
      // correction would take that day's weight with it. Null the ONE column instead,
      // and only drop the row when nothing is left on it.
      return writeTx(() => {
        const row = db
          .prepare(
            `SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics
              WHERE id = ? AND profile_id = ?`
          )
          .get(target.id, profileId) as
          | {
              weight_kg: number | null;
              body_fat_pct: number | null;
              resting_hr: number | null;
            }
          | undefined;
        if (!row) return { ok: false, undoId: null };
        const others = (
          ["weight_kg", "body_fat_pct", "resting_hr"] as const
        ).filter((c) => c !== target.column && row[c] != null);
        if (others.length === 0) {
          // The row exists only for this measure — capture it whole so the toast's undo
          // restores it (and its tombstone is written/removed with it).
          const undoId = captureDelete("body-metric", profileId, target.id);
          return { ok: undoId != null, undoId };
        }
        const info = bodyMetricClear(target.column).run(target.id, profileId);
        return { ok: info.changes > 0, undoId: null };
      });
    }
    case "medical_records": {
      const undoId = captureDelete("biomarker-record", profileId, target.id);
      return { ok: undoId != null, undoId };
    }
    case "metric_samples": {
      return writeTx(() => {
        const row = db
          .prepare(
            `SELECT metric, source, origin, start_time FROM metric_samples
              WHERE id = ? AND profile_id = ? AND metric = ?`
          )
          .get(target.id, profileId, target.metric) as
          Record<string, unknown> | undefined;
        if (!row) return { ok: false, undoId: null };
        const info = db
          .prepare(`DELETE FROM metric_samples WHERE id = ? AND profile_id = ?`)
          .run(target.id, profileId);
        // The pre-image was read BEFORE the delete — the row is gone now, and the
        // tombstone is what stops the next sync from re-inserting it (#508/#653).
        writeImportTombstoneForRow(profileId, "metric_samples", row);
        return { ok: info.changes > 0, undoId: null };
      });
    }
  }
}
