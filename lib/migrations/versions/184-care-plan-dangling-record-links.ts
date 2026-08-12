import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 184 (issue #2444) — null the `care_plan_items` links migration 180 left
// pointing at `medical_records` rows it had already deleted.
//
// WHAT WENT WRONG. Migration 180 moves waist-circumference readings out of
// `medical_records` and into `metric_samples`, and DELETES the record row it moved.
// It meant to skip a row a child table still references — its own header says so:
// "A row a child table still references (a follow-up lab, a projected medication, a
// care-plan item) is SKIPPED instead". Its `CHILD_LINKS` registry named four
// (table, column) pairs and three of them do not exist in any schema this repo has
// ever had: there is no `followup_labs` table, and `care_plan_items` has no
// `source_record_id`. The real columns, added by migrations 050/060, are
// `care_plan_items.source_medical_record_id` and `.resolved_by_medical_record_id`.
// Only the third entry, `intake_items.source_record_id`, was real.
//
// The registry is filtered through a `hasColumn()` PRAGMA probe that returns false
// for an absent table and drops the entry, so the misnamed pairs did not fail loudly
// — they just left the guard covering one link out of three. That is the whole defect:
// a protection that silently covers nothing still reads like a protection.
//
// AND THE DELETE WENT THROUGH. The runner applies migrations with `foreign_keys` OFF
// (see lib/migrations/runner.ts, issue #95), so nothing downstream objected: the
// `DELETE FROM medical_records` succeeded and any care-plan follow-up sourced from —
// or resolved by — that reading kept an id that no longer resolves. That damage is on
// disk on every database that had such a row, which is why the fix is a NEW forward
// migration and not an edit to 180 (shipped migrations are frozen by
// lib/migrations/manifest.json).
//
// THE REPAIR, in the app's OWN de-link convention. `lib/followup-write.ts` (the
// record-delete seam) and `lib/import-persist.ts` (the reassign sweep) both already
// answer "the linked reading is gone" the same way, and this copies them verbatim
// rather than inventing a third shape:
//   • the SOURCE link nulls `source_kind` with it — `source_kind` is the adapter
//     discriminator that makes the row a TRACKED follow-up at all, and a tracked
//     follow-up with no source is what `followup-findings.ts` calls de-linked;
//   • the RESOLVED-BY link nulls alone, leaving `source_kind` for the still-live
//     source side.
// `resolution` / `resolved_at` / `settled_*` are deliberately UNTOUCHED. The item
// genuinely was resolved when it was resolved; losing the evidence row is not grounds
// for reopening someone's closed follow-up, which would be a bigger claim than this
// issue makes (the #2318 posture on user-visible state).
//
// SCOPE. Only the two `care_plan_items` columns. `intake_items.source_record_id` was
// the one entry migration 180 got right, so its rows were skipped as designed and
// there is nothing to repair there; sweeping it anyway would be a claim about damage
// this issue has no evidence of.
//
// NOT COLUMN-GUARDED, on purpose. Both columns are added by migration 060, which is
// long past by the time this runs, so they are always present — and a
// silently-skipping presence probe is precisely the mechanism that produced the bug
// being fixed. If a column were somehow absent this should fail loudly, not no-op.
//
// Idempotent: a second run finds no dangling link and updates nothing. It is also
// correct for a database that never had a waist-circumference follow-up (no rows
// match) and for a fresh database migrating straight through (nothing to dangle).

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE care_plan_items
          SET source_kind = NULL, source_medical_record_id = NULL
        WHERE source_medical_record_id IS NOT NULL
          AND source_medical_record_id NOT IN (SELECT id FROM medical_records)`
    ).run();
    db.prepare(
      `UPDATE care_plan_items
          SET resolved_by_medical_record_id = NULL
        WHERE resolved_by_medical_record_id IS NOT NULL
          AND resolved_by_medical_record_id NOT IN (SELECT id FROM medical_records)`
    ).run();
  });
  run.immediate();
}

export const migration: Migration = {
  id: 184,
  name: "184-care-plan-dangling-record-links",
  up,
};
