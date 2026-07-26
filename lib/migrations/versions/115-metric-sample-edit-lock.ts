import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 115 (issue #1488, absorbing #1397): `metric_samples.edited` — the #133
// user-edit lock, extended to the third observation store.
//
// #133 gave `activities`, `body_metrics` and `medical_records` an `edited` flag: once
// the user hand-corrects an imported row, the keyed upsert skips it (counted
// `unchanged`) so the next rolling-window push can't overwrite the correction.
// `metric_samples` never got one, for the simple reason that it had NO edit path —
// #1397 verified there was not even a production `DELETE FROM metric_samples`, which
// is why a mis-typed manual HRV or sleep-hours reading was a true dead end.
//
// #1488's detail-page readings table gives every observation store per-row Edit and
// Delete, so metric_samples now has the edit path the flag exists to protect. Without
// this column, correcting an imported step count or HRV reading would survive exactly
// until the next sync silently restored the wrong number — the precise failure #133
// was filed about.
//
// The delete side needed no schema: `import_tombstones` already covers
// metric_samples (#508/#653).
//
// Defaults to 0, so every existing row is un-edited and behaves exactly as before.
export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(metric_samples)`).all() as {
    name: string;
  }[];
  // Replay-safe: the DB test tier replays migrations over an at-rest database
  // through the non-version-gated migrate() wrapper, and SQLite has no
  // `ADD COLUMN IF NOT EXISTS`.
  if (cols.some((c) => c.name === "edited")) return;
  db.exec(
    `ALTER TABLE metric_samples ADD COLUMN edited INTEGER NOT NULL DEFAULT 0`
  );
}

export const migration: Migration = {
  id: 115,
  name: "115-metric-sample-edit-lock",
  up,
};
