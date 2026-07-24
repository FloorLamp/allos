import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 106 (issue #1202): formalize ACTIVE (moving) vs ELAPSED (clock-span)
// activity time. `activities.duration_min` STAYS the active/effort time — the
// pace/volume/load source (zones.ts sums it as training minutes) — and is NOT
// repurposed. Elapsed (the wall-clock span, which for a paused session exceeds
// active by its in-leg rests + between-leg transitions) gets its OWN nullable
// column, primarily derived from `end_time − start_time` but stored here for the
// no-full-clock case (a source reporting elapsed without both timestamps, or
// manual elapsed) and so the value survives independent of the clock fields. The
// pure model lib/activity-timing.ts resolves it: stored `elapsed_min` preferred,
// else the `end−start` span.
//
// House rules: nullable column added via guarded ALTER TABLE ADD COLUMN (keeps the
// migrate() replay a no-op); no FK (a plain measure, not a link); activities is
// already profile-owned — this adds a column, not a table, so nothing new in
// OWNED_TABLES. Back-compat: seed `elapsed_min` from the clock span where BOTH
// times exist and the span is a plausible elapsed (positive and ≥ the stored
// active `duration_min`, the `elapsed ≥ active` invariant, #132). Historical rows
// whose parent was already FLIPPED to elapsed by a prior edit are indistinguishable
// from a genuine active total, so we deliberately do NOT try to un-flip them — we
// only seed the elapsed column alongside the (kept) active value.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "activities").has("elapsed_min")) {
    db.exec(`ALTER TABLE activities ADD COLUMN elapsed_min INTEGER;`);
  }

  // Seed elapsed from the stored wall-clock span (HH:MM, day-local) where it is a
  // plausible elapsed: a positive span that is at least the active duration. The
  // span math mirrors lib/activity-meta.ts minutesBetween (positive-only). Rows
  // with an implausible span (end ≤ start, or span < active) are left NULL so the
  // model falls back to nothing rather than surfacing a bogus "rest".
  db.exec(`
    UPDATE activities
       SET elapsed_min =
             (CAST(substr(end_time, 1, 2) AS INTEGER) * 60
                + CAST(substr(end_time, 4, 2) AS INTEGER))
           - (CAST(substr(start_time, 1, 2) AS INTEGER) * 60
                + CAST(substr(start_time, 4, 2) AS INTEGER))
     WHERE elapsed_min IS NULL
       AND start_time IS NOT NULL
       AND end_time IS NOT NULL
       AND (CAST(substr(end_time, 1, 2) AS INTEGER) * 60
              + CAST(substr(end_time, 4, 2) AS INTEGER))
         - (CAST(substr(start_time, 1, 2) AS INTEGER) * 60
              + CAST(substr(start_time, 4, 2) AS INTEGER)) > 0
       AND (CAST(substr(end_time, 1, 2) AS INTEGER) * 60
              + CAST(substr(end_time, 4, 2) AS INTEGER))
         - (CAST(substr(start_time, 1, 2) AS INTEGER) * 60
              + CAST(substr(start_time, 4, 2) AS INTEGER))
           >= COALESCE(duration_min, 0);
  `);
}

export const migration: Migration = {
  id: 106,
  name: "106-activity-elapsed-min",
  up,
};
