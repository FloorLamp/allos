import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5409 — the FIFTH source kind for the finding → follow-up → resolution chain:
// a follow-up whose source reading is a `metric_samples` row.
//
// WHY A COLUMN PAIR AND NOT A POLICY. #5409 moves a wearable breathing rate out of
// `medical_records` and into `metric_samples`, where it always belonged. A person who
// tapped "Track follow-up" on such a reading has a `care_plan_items` row naming it
// through `source_medical_record_id` — a link the move cannot follow, because the
// reading's new home had no column for it. Every answer that does not add one ends
// with the person's "Recheck breathing rate" either dangling (the row deleted under
// it), degraded to a generic care-plan item (the link freed), or still pointing at a
// row the vitals fold keeps mis-rendering (the reading left where it is). The owner's
// 2026-09-11 ruling names two acceptable resolutions, "carried or kept", and CARRIED
// is the first — so the reference moves with the reading.
//
// THIS IS THE TABLE'S ORDINARY GROWTH, not a special case for one metric.
// `care_plan_items` is already polymorphic over four source kinds, each grown as one
// `source_*` / `resolved_by_*` pair beside the discriminator: imaging studies
// (migration 050), medical records (060, shared by the labs and IOP adapters), dental
// procedures (065) and skin lesions (070). This is the fifth pair, on the same shape,
// and `RESOLVE_TARGET_BY_KIND` in lib/followup-write.ts picks it by `source_kind` the
// way it picks the other four.
//
// -- ON DELETE SET NULL, AND WHY IT DEPARTS FROM THE FOUR PAIRS ABOVE ---------------
//
// Migration 060 spells its pair with NO ON DELETE and frees the link by hand at each
// delete seam ("house style"). That style is what #5409's falsifying round was about:
// a blocking link is only as good as the survey that finds it, two of the six shipped
// migrations whose delete target had one declared it, and at runtime an unfreed
// blocking link raises SQLITE_CONSTRAINT_FOREIGNKEY inside somebody else's write.
//
// `metric_samples` is not `medical_records`: it HAS live delete paths that know
// nothing about follow-ups — the same-origin overlap supersede re-times a night and
// deletes the sample it replaced (#3628, lib/integrations/sleep-overlap-db.ts), the
// per-reading delete on a metric detail page (#1488), the offline queue's replay. A
// new NO ACTION link into it would make every one of those a potential throw, guarded
// by a hand survey of exactly the kind that just failed. `SET NULL` is the same policy
// those seams implement by hand — when the reading is gone the provenance is gone —
// but executed by SQLite at runtime and by `inboundDeleteLinks` inside a migration, in
// both postures, for every delete path including the ones written after this one.
//
// A follow-up whose source sample was deleted keeps its `source_kind` and loses its
// source id, which is the state `domainFollowUpItems` already skips (it requires a
// non-null source id) — the item stays in the care plan as the plain item it now is.
//
// REPLAY SAFETY: each ADD COLUMN is guarded behind a column-presence check, the index
// is IF NOT EXISTS, and the migration reads only the catalog. SQLite permits a
// REFERENCES clause on a brand-new nullable column (default NULL) — no table rebuild.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  const cols = new Set(columnNames(db, "care_plan_items"));
  if (cols.size === 0) return;
  if (!cols.has("source_metric_sample_id")) {
    db.exec(
      `ALTER TABLE care_plan_items
         ADD COLUMN source_metric_sample_id INTEGER
           REFERENCES metric_samples(id) ON DELETE SET NULL;`
    );
  }
  if (!cols.has("resolved_by_metric_sample_id")) {
    db.exec(
      `ALTER TABLE care_plan_items
         ADD COLUMN resolved_by_metric_sample_id INTEGER
           REFERENCES metric_samples(id) ON DELETE SET NULL;`
    );
  }
  // The source link is read per profile by the follow-up builder and written by the
  // #5409 adoption, which asks "which follow-ups name these readings" over a whole
  // delete-set at once; index it the way migration 060 indexes its own source link.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_care_plan_items_source_metric_sample
       ON care_plan_items(source_metric_sample_id)
       WHERE source_metric_sample_id IS NOT NULL;`
  );
}

export const migration: Migration = {
  name: "20260916-care-plan-metric-sample-links",
  up,
};
