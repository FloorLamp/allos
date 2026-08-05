import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 156 (issue #2111 half 2): index `intake_item_logs` on (item_id, given_at).
//
// The per-family latest-administration read inside `getMedicationFamilyStates`
// (lib/queries/intake/prn-family.ts) asks for the ARMING dose of an ingredient family:
//
//   WHERE l.item_id IN (…) AND l.status = 'taken' AND l.given_at IS NOT NULL
//   ORDER BY l.given_at DESC, l.id DESC LIMIT 1
//
// It carries NO date bound — deliberately, because the interval clock is armed by the
// family's most recent administration whenever that was. With only the baseline
// indexes (`(date)` and `(dose_id, date)`) SQLite answered it by scanning the WHOLE
// dose ledger through idx_intake_log_dose_date and then sorting the survivors:
//
//   SCAN l USING INDEX idx_intake_log_dose_date | USE TEMP B-TREE FOR ORDER BY
//
// `intake_item_logs` is append-only — every dose ever confirmed, several a day, for
// years — so that read degraded linearly with account age, once per ingredient family,
// on every dashboard and /medications render and on every tick.
//
// The composite serves it directly: `item_id` is the equality prefix, `given_at`
// orders within it, and the NOT NULL test is the same column. Measured after:
//
//   SEARCH l USING INDEX idx_intake_log_item_given (item_id=? AND given_at>?)
//
// with NO temp b-tree at all for the common single-member family (one item ⇒ the
// index already emits given_at order). A multi-member family still merges its two or
// three per-item seeks through a temp b-tree, but over the family's own rows rather
// than the entire ledger.
//
// WHY NOT (item_id, date) INSTEAD — the alternative the issue asked to measure. It
// serves the date-shaped reads (the family's today-count, the post-confirm summary in
// adherence.ts, the item-day administration list) but leaves the latest-administration
// query with its temp b-tree, and it is NOT the read that degrades: those all pin a
// single `date`, so the existing idx_intake_log_date already bounds them to one day of
// one household's logs — a set that stays flat as history grows. Shipping it too would
// buy a constant factor on already-bounded reads at the cost of a third b-tree insert
// per confirmed dose. Measured both plans; this index is the one that changes an
// asymptote, so it is the only one that ships. A future date-shaped read that is NOT
// day-bounded is a new migration, on new evidence.
//
// Both baseline indexes STAY: `(date)` serves every day-bounded read above and
// `(dose_id, date)` serves the per-dose adherence history, and neither is reachable
// through this one.
//
// Pure additive DDL — CREATE INDEX IF NOT EXISTS, so a fresh DB and an already
// converged one end identical and a replay is a no-op. No rebuild, so nothing to null
// beforehand. Determinism rule (spec): reads only the DB catalog.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_log_item_given
       ON intake_item_logs(item_id, given_at);`
  );
}

export const migration: Migration = {
  id: 156,
  name: "156-intake-log-item-given",
  up,
};
