import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2880. `activities.type = 'recovery'` always meant a mobility session,
// while `equipment` correctly keeps `recovery` for recovery devices. Rebuild the
// activity table with the product vocabulary, rewrite the row token and its stored
// component tokens, and preserve every other value, id, link, index, and sequence.
// Shipped migration 117 remains untouched: on a fresh replay it writes its historical
// token first and this later migration converts it, so no alias or dual-read is needed.

function rewriteComponents(json: string | null): string | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return json;
    let changed = false;
    for (const entry of parsed) {
      if (
        entry != null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "recovery"
      ) {
        (entry as { type: string }).type = "mobility";
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : json;
  } catch {
    return json;
  }
}

export function up(db: Database.Database): void {
  const sql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activities'"
      )
      .get() as { sql: string } | undefined
  )?.sql;
  if (sql == null || sql.includes("'mobility'")) return;

  const run = db.transaction(() => {
    const prior = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'activities'")
      .get() as { seq: number } | undefined;

    const componentRows = db
      .prepare(
        "SELECT id, components FROM activities WHERE components IS NOT NULL"
      )
      .all() as { id: number; components: string }[];
    const updateComponents = db.prepare(
      "UPDATE activities SET components = ? WHERE id = ?"
    );
    for (const row of componentRows) {
      const next = rewriteComponents(row.components);
      if (next !== row.components) updateComponents.run(next, row.id);
    }

    db.exec(`
    CREATE TABLE activities__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('strength','cardio','sport','mobility','unclassified')),
      title TEXT NOT NULL,
      notes TEXT,
      duration_min INTEGER,
      distance_km REAL,
      intensity TEXT,
      start_time TEXT,
      end_time TEXT,
      components TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT,
      external_id TEXT,
      avg_hr REAL,
      max_hr REAL,
      elevation_m REAL,
      avg_speed_kmh REAL,
      max_speed_kmh REAL,
      relative_effort REAL,
      avg_power_w REAL,
      max_power_w REAL,
      weighted_avg_power_w REAL,
      avg_cadence REAL,
      avg_temp_c REAL,
      kilojoules REAL,
      workout_type TEXT,
      edited INTEGER DEFAULT 0,
      updated_at TEXT,
      est_calories REAL,
      equipment_id INTEGER REFERENCES equipment(id),
      elapsed_min INTEGER
    );
    INSERT INTO activities__new
      (id, profile_id, date, type, title, notes, duration_min, distance_km,
       intensity, start_time, end_time, components, created_at, source,
       external_id, avg_hr, max_hr, elevation_m, avg_speed_kmh, max_speed_kmh,
       relative_effort, avg_power_w, max_power_w, weighted_avg_power_w,
       avg_cadence, avg_temp_c, kilojoules, workout_type, edited, updated_at,
       est_calories, equipment_id, elapsed_min)
      SELECT id, profile_id, date,
             CASE type WHEN 'recovery' THEN 'mobility' ELSE type END,
             title, notes, duration_min, distance_km, intensity, start_time,
             end_time, components, created_at, source, external_id, avg_hr,
             max_hr, elevation_m, avg_speed_kmh, max_speed_kmh, relative_effort,
             avg_power_w, max_power_w, weighted_avg_power_w, avg_cadence,
             avg_temp_c, kilojoules, workout_type, edited, updated_at,
             est_calories, equipment_id, elapsed_min
        FROM activities;
    DROP TABLE activities;
    ALTER TABLE activities__new RENAME TO activities;
    CREATE INDEX idx_activities_profile_date ON activities(profile_id, date);
    CREATE UNIQUE INDEX idx_activities_external
      ON activities(profile_id, external_id) WHERE external_id IS NOT NULL;
  `);

    if (prior != null) {
      const current = db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'activities'")
        .get() as { seq: number } | undefined;
      if (current == null) {
        db.prepare(
          "INSERT INTO sqlite_sequence(name, seq) VALUES ('activities', ?)"
        ).run(prior.seq);
      } else if (current.seq < prior.seq) {
        db.prepare(
          "UPDATE sqlite_sequence SET seq = ? WHERE name = 'activities'"
        ).run(prior.seq);
      }
    }
  });
  run.immediate();
}

export const migration: Migration = {
  name: "20260814-mobility-activity-type",
  up,
};
