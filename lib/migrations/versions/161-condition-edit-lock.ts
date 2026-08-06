import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 161 (issue #2137): `conditions.edited` — the #133 user-edit lock, extended
// to the one DERIVED row that never got it.
//
// An episode-promoted condition (source = 'episode', #801) is kept aligned with its
// episode by syncPromotedCondition, which runs on every promote, end, reopen, boundary
// edit, and merge — and until #2137 it rewrote name/status/onset_date/resolved_date
// unconditionally. Mark an episode-sourced condition resolved by hand (or correct its
// name or onset) and the correction survived exactly until the episode next
// transitioned, then reverted silently. That is precisely the class the edit lock
// exists for, and every OTHER derived or imported row already has the treatment:
// activities/body_metrics/medical_records since #133 (migration 002), metric_samples
// since #1488 (migration 115), practice_logs since migration 118, and providers'
// contact_edited since migration 084.
//
// The manual edit path (updateCondition) sets the flag; syncPromotedCondition and the
// merge-path value rewrite consult it through the SAME isEditLocked predicate the
// observation substrate uses and leave a locked row entirely alone — the full
// hold-out, providers-contact_edited style. Defaults to 0, so every existing row is
// un-edited and behaves exactly as before.
export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(conditions)`).all() as {
    name: string;
  }[];
  // Replay-safe: the DB test tier replays migrations over an at-rest database
  // through the non-version-gated migrate() wrapper, and SQLite has no
  // `ADD COLUMN IF NOT EXISTS`.
  if (cols.some((c) => c.name === "edited")) return;
  db.exec(
    `ALTER TABLE conditions ADD COLUMN edited INTEGER NOT NULL DEFAULT 0`
  );
}

export const migration: Migration = {
  id: 161,
  name: "161-condition-edit-lock",
  up,
};
