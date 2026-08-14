// A USER'S CORRECTION TO A DOCUMENT-DERIVED READING, CARRIED THROUGH A REPROCESS
// (issue #2364).
//
// A reprocess is delete-and-reinsert: `clearImportedDocumentRows` removes the
// document's whole footprint and `insertImportRows` writes it again under new ids.
// That is a load-bearing invariant — it is what makes the delete-set and the
// reprocess path the same code — and it must NOT grow per-table exceptions. So a
// correction is not preserved IN PLACE; it is CAPTURED before the clear and
// RE-APPLIED after the insert, exactly the shape `reapplyVisitLinkDecisions`
// (#1050/#1053) already uses for the other durable user decision a reprocess would
// otherwise discard.
//
// WHY THIS EXISTS AT ALL. `edited` used to protect against integration sync and
// nothing else, while the likeliest overwrite of a document-derived reading is the
// document's own reprocess — a re-extraction, a re-import from the saved raw
// extraction (#903, cheap and encouraged, no AI call), or a reprocess-all. Neither
// `lib/import-footprint.ts` nor `lib/import-persist.ts` mentioned `edited`, so a
// correctly locked row was deleted anyway, silently, with no diff saying "3
// corrections will be lost".
//
// KEYED ON IDENTITY, NEVER ON ROW ID. The rows come back under new ids, so the
// question is "which reading is this the correction TO", and the app already has one
// answer for that: #482 identity (`biomarkerFamily`) plus the reading's day. UNIT is
// in the key too, compared case-insensitively — a re-extraction that reports the same
// analyte in a different unit is a different quantity, and pasting 5.2 onto a mg/dL
// row would be corruption dressed as a rescue. It is reported as orphaned instead.
//
// AN ORPHAN IS REPORTED, NOT RESURRECTED. A correction whose reading the new
// extraction no longer produces has nothing to re-apply to. Re-inserting the row
// would put back something the document stopped claiming; dropping it in silence is
// the defect this issue is about. So it becomes an `ImportDrop` on the document's
// import report — the user learns their correction lost its subject.
//
// NO SCHEMA CHANGE: the capture lives for the duration of one persist transaction,
// because the rows it describes are deleted and re-inserted inside that same
// transaction. Nothing is stored between reprocesses.
//
// NOT AN `IMPORT_SIDE_EFFECTS` ENTRY, deliberately. That inventory covers the
// NON-ROW effects a footprint table cannot account for — a profile field adopted, a
// name-keyed dismissal swept. This writes two columns of a row the footprint already
// owns (`medical_records`), inside the same transaction that inserted it, so the
// delete and reassign questions the inventory forces are already answered by the
// footprint itself: on a document delete the corrected row leaves with the document,
// on a reassign it moves with it. Same reason `reapplyVisitLinkDecisions` has no slot.

import { db } from "./db";
import { biomarkerFamily } from "./canonical-name";
import type { ImportDrop } from "./import-report";

// One hand-corrected reading captured off a document's footprint, with everything
// needed to find its counterpart again and re-state the user's value.
export interface DocumentCorrection {
  /** The reading's identity spelling — canonical when it has one, else its printed name. */
  identity: string;
  /** What to show the user if this correction turns out to have no subject. */
  label: string;
  date: string;
  unit: string | null;
  /** The corrected value, in both the stored shapes `medical_records` keeps. */
  value: string | null;
  valueNum: number | null;
}

// The identity a correction and a freshly-inserted row are matched on: #482
// biomarker family + the reading's own day + its unit, folded case-insensitively.
// `\u0000` cannot occur in any of the three, so the key can't collide across fields.
function correctionKey(
  identity: string,
  date: string,
  unit: string | null
): string {
  return `${biomarkerFamily(identity)}\u0000${date}\u0000${(unit ?? "")
    .trim()
    .toLowerCase()}`;
}

/**
 * The document's hand-corrected readings, in row order. Called BEFORE
 * `clearImportedDocumentRows` — after it there is nothing left to read.
 *
 * Empty on a first import (the document has no prior rows), so the re-apply below
 * no-ops there and a fresh import pays one indexed SELECT.
 */
export function captureDocumentCorrections(
  profileId: number,
  docId: number
): DocumentCorrection[] {
  const rows = db
    .prepare(
      `SELECT canonical_name, name, date, unit, value, value_num
         FROM medical_records
        WHERE profile_id = ? AND document_id = ? AND edited = 1
        ORDER BY id`
    )
    .all(profileId, docId) as {
    canonical_name: string | null;
    name: string;
    date: string;
    unit: string | null;
    value: string | null;
    value_num: number | null;
  }[];
  return rows.map((r) => ({
    identity: r.canonical_name ?? r.name,
    label: r.canonical_name ?? r.name,
    date: r.date,
    unit: r.unit,
    value: r.value,
    valueNum: r.value_num,
  }));
}

/**
 * Re-state each captured correction onto the reading the fresh insert produced for
 * the same identity, and report the ones with no counterpart.
 *
 * Called AFTER `insertImportRows`, inside the same transaction. Same-day duplicates
 * of one identity are a real thing (#800/#843 — a second temperature is a fever
 * curve, not a correction), so corrections and candidate rows are paired IN ORDER
 * within their key group; a correction with no row left to pair with is orphaned.
 *
 * The re-applied row keeps `edited = 1`: the value is still the user's, and the next
 * reprocess must capture it again. Flags are NOT re-derived here — every persist
 * caller runs `applyImportFollowups` with this import's `insertedObservationIds`, and
 * these rows are among them, so the post-commit `reconcileFlags` sees the corrected
 * values (a corrected-down reading must not keep its old "high", #221).
 */
export function reapplyDocumentCorrections(
  profileId: number,
  docId: number,
  corrections: readonly DocumentCorrection[]
): ImportDrop[] {
  if (corrections.length === 0) return [];

  const fresh = db
    .prepare(
      `SELECT id, canonical_name, name, date, unit
         FROM medical_records
        WHERE profile_id = ? AND document_id = ?
        ORDER BY id`
    )
    .all(profileId, docId) as {
    id: number;
    canonical_name: string | null;
    name: string;
    date: string;
    unit: string | null;
  }[];

  const available = new Map<string, number[]>();
  for (const row of fresh) {
    const key = correctionKey(
      row.canonical_name ?? row.name,
      row.date,
      row.unit
    );
    const ids = available.get(key);
    if (ids) ids.push(row.id);
    else available.set(key, [row.id]);
  }

  const restate = db.prepare(
    `UPDATE medical_records SET value = ?, value_num = ?, edited = 1
      WHERE id = ? AND profile_id = ?`
  );
  const orphaned: ImportDrop[] = [];
  for (const c of corrections) {
    const ids = available.get(correctionKey(c.identity, c.date, c.unit));
    const target = ids?.shift();
    if (target === undefined) {
      orphaned.push({
        kind: "lab",
        label: c.label,
        reason: "correction_orphaned",
      });
      continue;
    }
    restate.run(c.value, c.valueNum, target, profileId);
  }
  return orphaned;
}
