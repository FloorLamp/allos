import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// #3198 — the ONE-TIME re-classification of what is already stored in
// `integration_backfill_jobs.error`.
//
// That column is rendered onto the owning profile's settings card, and a failed
// ride-detail job put `UNIQUE constraint failed: activity_segment_efforts.profile_id,
// activity_segment_efforts.source, activity_segment_efforts.external_id` there — a
// SQLite internal, on a page addressed to someone tracking their health, where it sat
// for a week. Every FUTURE write is house copy now (lib/user-error-copy.ts), but the
// stored one would survive until somebody happened to re-run the job.
//
// THE PREDICATE IS DELIBERATELY NARROW, matching SQLite's own vocabulary rather than
// "anything that does not look like house copy". Three different writers fill this
// column — the `N items could not be completed` sentence, a runner's own `{ error }`
// string, and the catch-all — and only the third was ever raw. A row wrongly rewritten
// is INVISIBLE (the person reads a generic sentence and never learns it replaced a
// real one); a machine string this misses is VISIBLE, and the next run rewrites it.
// So the conservative direction is to under-match, and that is the direction taken.
//
// Determinism: reads and writes one text column, no clock, no environment.
export function up(db: Database.Database): void {
  db.prepare(
    `UPDATE integration_backfill_jobs
        SET error = 'Couldn''t finish this backfill. It''s a bug on our side.'
      WHERE error IS NOT NULL
        AND (error LIKE '%constraint failed%'
             OR error LIKE '%SQLITE_%'
             OR error LIKE '%datatype mismatch%'
             OR error LIKE '%no such table%'
             OR error LIKE '%no such column%')`
  ).run();
}

export const migration: Migration = {
  name: "20260823-backfill-error-house-copy",
  up,
};
