import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 009 (issue #151): a nullable `est_calories` on activities.
//
// Manually-logged activities carry no device-measured energy. The app now ESTIMATES
// their calorie burn from the baked MET dataset (lib/mets.json) × the profile's
// nearest bodyweight × the activity's duration (lib/calorie-estimate.ts). This
// column stores that estimate for a MANUAL activity — the auto-value the activity
// form fills, or the user's manual override of it.
//
// It is deliberately SEPARATE from any device metric: device-measured calories for
// imported activities live in metric_samples (active_kcal/total_kcal) and are never
// written here, and the `kilojoules` column stays what it is (Strava's mechanical
// work output, cycling only). So an estimate can never overwrite or be confused with
// a measured value — the manual-vs-integration source separation the rest of the app
// keeps. The integration upserts don't touch this column, so a rolling-window
// re-push leaves it untouched.
//
// OPTIONAL: existing rows (seed/legacy/imported) stay NULL; the display/recap layer
// falls back to a freshly computed estimate for a NULL manual row, so no backfill is
// needed. Replay-safe by construction — the ADD COLUMN is guarded on
// PRAGMA table_info so the non-version-gated `migrate()` test wrapper (which replays
// every migration) doesn't hit "duplicate column name"; production applies it
// exactly once behind the user_version gate. Determinism: reads only the DB + its
// own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "activities").has("est_calories")) {
    db.exec(`ALTER TABLE activities ADD COLUMN est_calories REAL;`);
  }
}

export const migration: Migration = {
  id: 9,
  name: "009-activity-est-calories",
  up,
};
