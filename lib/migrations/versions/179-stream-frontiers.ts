import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 179 — where a continuous stream's FRONTIER and its movement are recorded
// (#2341).
//
// One row per (profile, provider, stream): the newest instant that stream had reached
// when the ingest path last looked, when that value was last seen to ADVANCE, and how
// many successful syncs have landed against it since. That last number is the whole
// point — "did the frontier move" is what separates a watch on a charger from a watch
// on a wrist behind a 30–61 minute push lag, and it cannot be derived from a single
// read of `MAX(hr_minutes.ts)` however the threshold is tuned.
//
// WHY A TABLE, given two existing candidates were considered and rejected:
//   • `integration_sync_rows` — its `target_table` CHECK enumerates five record tables
//     and excludes the stream tables BY DESIGN, and it stores one row per written
//     record: ~1500/day for heart-rate minutes alone. It is per-row provenance, not a
//     per-stream watermark.
//   • `integration_sync_events.window_start/window_end` — the exporter's own
//     day-grained rolling window (`2026-08-07` → `2026-08-09` on every single push).
//     It describes what was ASKED for, not what arrived.
//
// So this is a watermark table, and it is deliberately tiny: bounded by
// profiles × declared continuous streams (one, today), updated in place.
//
// ── The three instants ───────────────────────────────────────────────────────
//
// All three are CANONICAL UTC (`YYYY-MM-DDTHH:MM:SSZ`, #2205) and are BORN on that
// convention — the table is new, so there is nothing to convert and nothing to get
// wrong. They are declared in lib/time-columns.ts and in the instant-writer scan's
// registry in this same change, which is what forces the first writer to bind
// `instantNow()`/`utcInstant()` instead of choosing a serialization at the call site.
// No column DEFAULT: a default would be SQLite's own bare `datetime('now')` shape, and
// mixing that into a canonical column is exactly the failure #2205 exists to end.
//
// `frontier_at` is NULLABLE — a connected provider whose stream has never delivered a
// row is a real state, and it is not "quiet": there is no baseline to be silent
// against. The predicates short-circuit on it.
//
// NO BACKFILL, on purpose. "When did this frontier last advance" is not recoverable
// from the rows on disk — a stream that has been frozen for an hour and one that
// advanced thirty seconds ago look identical in `hr_minutes`. Inventing an
// `advanced_at` here would be asserting an observation nobody made. The first push
// after deploy creates the row (an advance, since there is no previous value), and
// until then both readers report "not enough evidence" and stay silent, which is the
// safe direction. At the measured median 16-minute push cadence that gap closes on its
// own within minutes.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_frontiers (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      provider            TEXT NOT NULL,
      stream              TEXT NOT NULL,
      frontier_at         TEXT,
      advanced_at         TEXT NOT NULL,
      observed_at         TEXT NOT NULL,
      syncs_since_advance INTEGER NOT NULL DEFAULT 0
        CHECK (syncs_since_advance >= 0),
      UNIQUE(profile_id, provider, stream)
    );
  `);
}

export const migration: Migration = {
  id: 179,
  name: "179-stream-frontiers",
  up,
};
