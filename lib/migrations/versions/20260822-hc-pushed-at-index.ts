import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3424 — the index the store-derived overlap-supersede reads.
//
// WHY IT EXISTS. The owner's ruling of 2026-08-22 moved the victim set off the payload
// and onto the store: inside the last chunk's IMMEDIATE transaction, the supersede asks
// `metric_samples` which rows carry THIS push's stamp, and derives everything from that
// one answer (lib/integrations/normalize.ts, `supersedeMetricSampleOverlaps`). That
// question is `WHERE profile_id = ? AND source = ? AND pushed_at = ?`, and no index in
// the table answers it: `idx_metric_samples_natural` leads with the natural key,
// `idx_metric_samples_md` with (profile_id, metric, date). Without this index every
// Health Connect push scans the profile's whole `metric_samples` history — under the
// write lock, once per push — which is not a cost the ruling's "a handful of indexed
// range queries" describes.
//
// IT IS SEPARATE FROM `20260821-hc-overlap-supersede`, which added the column, because
// that migration is already on this branch with its manifest hash recorded and a shipped
// migration is never edited.
//
// PARTIAL, ON `pushed_at IS NOT NULL`, AND THAT IS WHAT MAKES IT FREE ON DEPLOY DAY. The
// column landed in the migration before this one, so every row is NULL when this runs and
// the index is built EMPTY — no scan of existing rows, the same "touches no row" boot the
// column's own migration was written for. It then grows with the rows Health Connect
// pushes actually stamp, which is the set the query selects from anyway; every
// non-Health-Connect row and every pre-column row stays out of it for good.
//
// The leading columns are the ones the query pins to equality, in that order: a profile,
// a source, an exact stamp.
export function up(db: Database.Database): void {
  db.transaction(() => {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_metric_samples_pushed
         ON metric_samples(profile_id, source, pushed_at)
         WHERE pushed_at IS NOT NULL;`
    );
  }).immediate();
}

export const migration: Migration = {
  name: "20260822-hc-pushed-at-index",
  up,
};
