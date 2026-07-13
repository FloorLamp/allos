import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 033 (issue #659): the edit-lock skip gets its own honest sync-event
// count, parallel to the tombstone `suppressed` column (migration 023).
//
// A re-sync that finds a hand-edited (edit-locked, #133) imported row leaves it
// untouched. Before this it was folded into `unchanged`, indistinguishable from an
// ordinary no-op re-send — so a user who hand-corrected a weight and wonders why the
// scale "stopped updating" it had nothing to find in Data → Review. This adds:
//
//   • integration_sync_events.edited — a nullable count column so an edit-locked skip
//     is accounted for on its own ("N edited" in the Review split) rather than hiding
//     inside `unchanged`. Null on failure events / legacy rows (treated as 0 by the
//     pure formatter, formatSplitLabel).
//
// Pure additive DDL: an ADD COLUMN guarded on PRAGMA table_info, so a fresh DB and an
// already-converged one both end identical and the non-version-gated migrate() wrapper
// replays it as a no-op. Determinism (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "integration_sync_events").has("edited")) {
    db.exec(`ALTER TABLE integration_sync_events ADD COLUMN edited INTEGER;`);
  }
}

export const migration: Migration = {
  id: 33,
  name: "033-sync-event-edited-count",
  up,
};
